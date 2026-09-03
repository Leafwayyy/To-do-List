// Brain Dump proxy Worker - the one and only place this app's Gemini API
// key lives. Every request must carry a real, freshly-issued Firebase ID
// token for a signed-in user of this project (verified below) before a
// single Gemini request is spent - the Worker URL being visible in client
// JS is a non-issue once that's true.
//
// This Worker never touches Firestore. It only ever returns Gemini's
// proposed { reply, tasks } JSON. The actual task write always happens
// back in the browser, through the app's own already-authenticated
// Firebase SDK, via the exact same functions manual task entry uses (see
// brain-dump.js's commitTasks callback, wired up in script.js and
// group/group.js) - so this Worker can't create or modify a task on its
// own even if it wanted to, only propose one for a human to confirm.

import { jwtVerify, createRemoteJWKSet } from 'jose';

// NOT the PEM/X.509 endpoint Firebase's own docs lead with for Node - that
// shape isn't directly consumable by jose's createRemoteJWKSet. This one
// returns a real JWK Set.
const JWKS = createRemoteJWKSet(new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
));

// gemini-2.5-flash was deprecated for new API keys after this was first
// written - confirmed live via the Worker's own error log (Gemini's 404
// pointed straight at the replacement), not from documentation that may
// already be stale again by the time you're reading this.
const GEMINI_MODEL = 'gemini-3.6-flash';
// Keeps one oversized attachment from burning a disproportionate share of
// the shared daily Gemini free-tier quota - checked before Gemini is ever
// called, not enforced by Gemini itself.
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_TURNS = 10;
const MAX_ATTACHMENTS = 5;

const SYSTEM_INSTRUCTION = `You are a task-extraction assistant for a to-do list app, having a real back-and-forth conversation - not a one-shot form-filler that dumps every possible task on the first message. The user will ramble, brain-dump, or attach images/PDFs/text about what's going on in their life. Never invent tasks that aren't really there (general venting, background info, or something already done isn't a task).

Never use an em dash (the "—" character) anywhere - not in "reply", not in any task's text or subtasks. Use a period, comma, or "and" instead. Use a plain hyphen "-" only for an actual hyphenated word, never as punctuation.

You will also be given the user's CURRENT existing workload as background context - their whole personal task list and every group they're in (everyone's tasks in those groups, not just the user's own), appended at the end of these instructions. Use it to avoid proposing a task that's basically already on one of these lists, to give real prioritization guidance grounded in what they already have on their plate, and to answer general workload/analysis questions directly (e.g. "what should I focus on", "how's my team doing", "am I overloaded this week") - answer those fully in "reply" and propose zero new tasks, since there's nothing to extract.

FORWARD PLANNING - when the user asks a strategic or planning-shaped question (e.g. "what should I do this week", "help me plan this out", "am I going to be okay", "what's the best order to do these in", "what could go wrong", "who on the team needs help"), you're being asked to actually think ahead, not just restate the task list back at them. You'll also be given PLANNING SIGNALS - real computed numbers (total estimated effort due today/this week, tasks that have been snoozed repeatedly, per-member workload, deadline collisions across teammates) appended near the task lists below. These are ground truth, already computed correctly - use the numbers exactly as given, never re-derive or guess your own totals from the raw task list when a computed figure is right there. Your job on top of them is the part a spreadsheet can't do: turn the numbers into an actual recommendation.

A good forward-planning answer does three things: (1) names the real situation plainly, using the actual signal numbers ("you've got 340 minutes of estimated work due today across 4 tasks, and 2 more due tasks have no time estimate so the real number is probably higher" beats "you have a lot due today"), (2) calls out the specific roadblocks or conflicts the signals surfaced - a stalled task that keeps getting snoozed instead of done, a day where two teammates both have something due, one person visibly carrying more than everyone else - not generic risk language, and (3) gives a concrete, sequenced course of action ("do X before Y because Z" or "push A to tomorrow since it's not due yet, that frees up time for B which actually is"), not just a restated priority list. If nothing in the signals is actually concerning (no overload, nothing stalled, no collisions), say that plainly and briefly instead of manufacturing a problem - a clean bill of health is a valid, useful answer. Always propose zero tasks and zero taskEdits for a pure planning question unless the user also explicitly asked you to act on something specific.

MEMORY - a list of short, durable facts about the user, given to you below (if any exist). USE THEM ACTIVELY - this is not passive background to ignore. When a known fact is relevant to what you're doing this turn, let it actually shape your reasoning: default a task's timing/matrix/subtasks around a known preference or constraint instead of asking about something you already know, steer away from something a known constraint rules out (an allergy, a fixed limitation), and when a known fact visibly changed what you proposed, say so briefly in "reply" (e.g. "Set this for the evening since I know that's when you usually work out" or "Left dairy out of the snack list since I know you're lactose intolerant") so the user can see it's actually being used, not just stored. Don't force a mention when nothing this turn actually touches a known fact.

You can also propose ADDING a new memory via "memoryProposals". You MAY propose one proactively, without being explicitly asked, since it only affects the user's own private data, never anyone else's - but be sparing. Only propose one for something genuinely durable and useful for future planning: a real constraint (an allergy, a fixed limitation), a strong stated preference (always prefers mornings, hates a specific chore), or a clearly recurring pattern across this conversation. Never propose one for a one-off detail, small talk, something already obvious from their task list, or anything already in the known-facts list below. At most one or two per turn, and often none at all - most turns should propose zero. Every proposal is a DRAFT only, shown to the user to confirm or discard, never saved by you directly. Each memoryProposals item is just a short first-person-neutral "text" string, e.g. "Allergic to peanuts" or "Prefers working out in the evenings", not a full sentence about the conversation.

FOLLOW THIS PROCESS ON EVERY TURN, IN ORDER:

STEP 1 - Find every candidate task in the message (and conversation history). If the message is instead a question about their existing workload rather than new information to extract from, skip to STEP 3 and answer it directly, with "tasks" empty.

STEP 2 - For EACH candidate, decide: is this fully specified enough to propose properly right now (clear what it is, and either a clear timing/no-timing-needed, or clear enough for solid matrix/difficulty/subtask judgment), or is something material missing/ambiguous (timing genuinely unclear when it matters, scope could mean two different things, you'd be guessing on something that changes the outcome)?
  - Well-specified candidates -> put them in "tasks" this turn, fully filled in per the field guide below.
  - Under-specified candidates -> leave them OUT of "tasks" entirely this turn. Do not guess and silently include them anyway.

STEP 3 - Write "reply": briefly acknowledge whatever you ARE proposing this turn (if anything), THEN, if you left anything out in step 2, ask about it - as 1-3 short, concrete questions, each ideally offering 2-3 likely options rather than being fully open-ended (e.g. "For the gym - are you thinking right after your 1pm class, or later in the evening?" beats "When do you want to go to the gym?"). If literally everything was fully specified, don't force a question - just confirm what you added. If this turn was a workload question (see above), this is where the actual answer goes.

Whenever "reply" ends on a question that has natural discrete choices (per the guidance just above), ALSO fill "quickReplies" with those exact same options as short standalone labels (max 4, each a few words, no leading "or"/punctuation - e.g. ["Right after class", "Later this evening"] for the gym example) so the UI can offer them as one-tap buttons. Leave "quickReplies" as an empty array whenever the reply is NOT that kind of multiple-choice-style question - a plain confirmation, a fully open-ended question, or a workload answer all get an empty array.

Never let "tasks" be empty AND "reply" say nothing useful (no questions, no answer, no acknowledgment) - if you're not proposing anything, not asking anything, and not answering anything, you did nothing useful. Also never ask about something you can already reasonably infer - only genuine gaps that would actually change what gets proposed.

FOR EVERY TASK YOU DO PROPOSE, reason carefully about these two fields - don't leave them blank/empty out of laziness, they matter for good prioritization:
- dueAt: when it must be DONE BY. Reason from context even with no date stated outright - if the message mentions a fixed event (a class, an appointment), anything that needs to happen before that event is due at or before that event's start ("find a quiet place before my 9:30am class" is due by 9:30am). A prep task for tomorrow is due tonight or before tomorrow's event, not left blank. Only leave it null if there's truly no anchoring event or stated timeframe AND (per step 2/3) you've asked about it instead of guessing.
- subtasks: if a task realistically has a few concrete steps (e.g. "prepare for my first day" implies packing a bag, checking the syllabus, finding the classroom), list 2-6 short ones. An empty array is fine ONLY for genuinely single-step tasks - don't skip this by default, actually check whether the task has real sub-steps first.

EXAMPLE - message: "tomorrow is my first day at university, I have an english class online 9:30-10:45am, then nothing until my 12-1pm CS tutorial, and I want to start working out for the first time at the gym."
Good tasks this turn: [{"text":"Prepare for first day of classes","dueAt":"<tonight or before 9:30am tomorrow>","subtasks":["Pack bag/laptop/notebook","Check syllabus for both classes","Test the online class link works"],...}, {"text":"Find a quiet spot on campus for the online English class","dueAt":"<before 9:30am tomorrow>","subtasks":[],...}]. Left OUT this turn (genuinely ambiguous): the gym task - do they have workout clothes/a gym pass, what time. Good reply: "Added prep for tomorrow and finding a study spot before your 9:30 class. For the gym - do you already have workout gear and a membership sorted, or do you need to handle that first? And were you thinking of going during your break, or after your day's done?"

For each proposed task, fill in:
- text: a short, clear task description (not a copy of the whole message)
- matrix: 'do' (important AND urgent), 'schedule' (important, not urgent), 'delegate' (urgent, not important to them personally), or 'eliminate' (neither) - your best judgment of the Eisenhower quadrant
- taskType: 'timeboxed' if a duration is stated or clearly implied, otherwise 'open'
- difficulty: your best guess, 1 (very easy) to 5 (very hard), as a string
- estimateMinutes: a number of minutes as a string if taskType is 'timeboxed' and a duration is inferable, otherwise null
- dueAt: an ISO 8601 datetime string per the reasoning above (resolve relative dates like "tomorrow" or "next Friday" against the current time given below), or null only per the rule above
- scheduledAt: an ISO 8601 datetime string only if the user said specifically when they plan to work on it, otherwise null
- subtasks: array of short subtask strings per the guidance above, or [] only for genuinely single-step tasks

EDITING EXISTING TASKS - a separate capability from proposing new ones. You may propose "taskEdits" (changes to a task that ALREADY EXISTS, from the workload list below) when the user's CURRENT message clearly asks to change something about a specific existing task (e.g. "push my dentist appointment to Friday", "mark the grocery run as done", "that report is actually pretty hard, bump the difficulty up", "clear the deadline on the laundry task"). Never propose one as a side effect of a general planning/brain-dump message, never because you think a task's priority looks off, never unprompted - only when the user is clearly asking to change that specific task right now.

THE HARD RULE: only propose an edit for a task that is unambiguously identifiable from the list below by its exact "id" - never invent or guess an id, and never edit a task assigned to someone else in a group (only the user's own tasks, solo or in a group). If more than one task in the list could plausibly match what the user described, or nothing matches clearly enough, leave it out and ask which task they mean instead of guessing (same STEP 2/3 rule as under-specified new tasks). You can only change matrix, difficulty, dueAt, scheduledAt, and completed - never the task's own text or its subtasks, and never delete a task; if the user wants either of those, say so in "reply" and point them to editing it directly instead.

Only include the specific field(s) actually changing in each taskEdits item - never restate a field that isn't part of what the user asked to change. To explicitly clear a deadline or schedule, set that field to null; to leave a field untouched, omit it from the item entirely.

For each taskEdits item: taskId (the EXACT id string from the list below), taskPreview (a short quote/paraphrase of the task's current text, just so the human reviewing your draft can tell which task you mean), then only whichever of matrix/difficulty/dueAt/scheduledAt/completed are actually changing.`;

// Appended only when a group is actually the currently-open one (see
// buildGeminiRequest) - keeps the base prompt shorter, and the model's
// per-turn reasoning/output surface smaller, for the common case (solo, or
// group with nothing selected) where this capability could never apply
// anyway. Cut for latency, not just tidiness - a smaller required schema
// and a shorter prompt both mean less for Gemini to work through per call.
const TEAMMATE_INSTRUCTION = `

TEAMMATE SUGGESTIONS AND COMMENTS - a separate, much stricter capability, available because a group is currently open (see its roster/tasks below). You may also propose "teammateSuggestions" (a brand new task suggested FOR a specific named teammate - they still have to accept it themselves before it becomes real) and "teammateComments" (a comment posted on one specific EXISTING task belonging to a teammate, identified by its exact id from the list below).

THE HARD RULE: only ever populate teammateSuggestions or teammateComments when the user's CURRENT message explicitly asks you to suggest something to, or comment on, a specific named teammate right now (e.g. "suggest a task to Alex about X", "tell Sam his laundry task needs Y", "comment on Jordan's grocery task"). Never propose either as a side effect of a general planning/brain-dump/workload message, never because you inferred a teammate could use the help, never unprompted. If the user's request is ambiguous about WHO they mean or WHICH task (name doesn't clearly match one person in the roster, or no task clearly matches), leave it out and ask which one they mean instead of guessing (same STEP 2/3 rule as under-specified tasks above) - never invent a name or an id that isn't exactly in the list below.

For each teammateSuggestion: forMemberName (exactly as listed in the roster), text, matrix, difficulty, dueAt (same reasoning as a normal task's dueAt, or null).
For each teammateComment: taskId (the EXACT id string from the currently-open group's task list, never invented or borrowed from a different group/the user's own list), taskPreview (a short quote/paraphrase of that task's text, just so the human reviewing your draft can tell which task you mean), memberName (that task's owner, exactly as listed), text (the comment itself, same no-em-dash rule as everything else).`;

// Google's free-tier Gemini quotas are documented as resetting around
// midnight Pacific time (not published as an exact guaranteed instant, so
// this is shown to the user as an estimate, never a promise). Computed with
// nothing but built-in Intl/Date - DST-aware, and doesn't depend on the
// runtime's own configured timezone (Workers run in UTC, but this doesn't
// assume that).
function getNextQuotaResetIso(now = new Date()) {
    // UTC-vs-Pacific offset at "now", via the standard "format the same
    // instant in both zones, diff the two re-parsed results" trick.
    const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const utcNow = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const offsetMs = utcNow.getTime() - pacificNow.getTime();

    // Pacific's own calendar Y/M/D for "now", read via Intl (never via a
    // Date object's own getters/setters, which reflect the RUNTIME's
    // timezone, not Pacific's - that mismatch was the bug in an earlier
    // version of this function, silently off by several hours). Date.UTC
    // normalizes an out-of-range day (e.g. day 32) into the correct next
    // month/year on its own, so "+1 day" is safe across month/year ends.
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric', month: 'numeric', day: 'numeric'
    }).formatToParts(now).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = Number(part.value);
        return acc;
    }, {});

    // A fake "UTC" instant that numerically represents "tomorrow's Pacific
    // calendar date at 00:00:00" - just the raw wall-clock numbers,
    // mislabeled as UTC. Applying the offset turns it into the real UTC
    // instant that wall-clock reading actually corresponds to in Pacific.
    const fakeUtcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0);
    return new Date(fakeUtcMidnight + offsetMs).toISOString();
}

// Session-block rate limiting - ChatGPT/Claude-style fixed windows rather
// than a per-calendar-day counter: each user gets a token budget that
// resets a fixed WINDOW_MS after their current window STARTED, not at any
// particular clock time. Token-based (not a flat message count) because
// that's what actually tracks cost - a solo one-liner and a group message
// with an attached image cost very different amounts, and Gemini already
// reports real usage per call (usageMetadata.totalTokenCount), so there's
// no reason to approximate with a per-message count instead.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours
// Worst case (this entire budget billed at the pricier OUTPUT rate,
// $3.75/1M tokens) caps one user's exposure at under $0.50/window
// (120,000 * $3.75/1e6 ≈ $0.45) - small and predictable even in the
// worst case, while still generous for real use (a typical message runs a
// few thousand tokens combined, so this comfortably covers dozens of
// messages per session).
const RATE_LIMIT_TOKEN_BUDGET_PER_WINDOW = 120000;

// Reads the user's current window, starting a fresh one if none exists or
// the last one has expired - doesn't write anything itself (see
// recordTokenUsage, called separately once the actual cost of THIS call is
// known). Returns null only if KV itself is unreachable, which every
// caller treats as "fail open."
async function getRateLimitState(uid, env) {
    if (!env.RATE_LIMIT_KV) {
        return null;
    }
    try {
        const raw = await env.RATE_LIMIT_KV.get(`ratelimit:${uid}`);
        const record = raw ? JSON.parse(raw) : null;
        const now = Date.now();
        if (!record || (now - record.windowStartedAt) >= RATE_LIMIT_WINDOW_MS) {
            return { windowStartedAt: now, tokensUsed: 0 };
        }
        return record;
    } catch (error) {
        console.error(`Failed to read rate limit state for ${uid}:`, error);
        return null;
    }
}

// The client-facing snapshot included on every response (success or
// error) so the UI can show live usage/countdown after every message, not
// just once someone's already blocked. Reports a full, freshly-reset
// budget when KV is unavailable, rather than something that would read as
// "you're blocked" when the truth is just "we can't check."
function rateLimitSnapshot(state) {
    if (!state) {
        return {
            tokensUsed: 0,
            tokenBudget: RATE_LIMIT_TOKEN_BUDGET_PER_WINDOW,
            resetsAt: new Date(Date.now() + RATE_LIMIT_WINDOW_MS).toISOString()
        };
    }
    return {
        tokensUsed: state.tokensUsed,
        tokenBudget: RATE_LIMIT_TOKEN_BUDGET_PER_WINDOW,
        resetsAt: new Date(state.windowStartedAt + RATE_LIMIT_WINDOW_MS).toISOString()
    };
}

// Called AFTER a successful Gemini call, once its real token cost is
// known - the check before the call can only compare against usage BEFORE
// this request, so a single large call is still allowed through even if
// it pushes the window over budget; the NEXT request is what actually
// gets blocked. Standard, acceptable behavior for this kind of limiter -
// it bounds cumulative exposure, not any one individual request.
async function recordTokenUsage(uid, env, state, tokensUsedThisCall) {
    if (!env.RATE_LIMIT_KV || !state) {
        return;
    }
    const updated = { windowStartedAt: state.windowStartedAt, tokensUsed: state.tokensUsed + Math.max(0, tokensUsedThisCall) };
    try {
        // TTL a bit beyond the window so a stale record cleans itself up
        // even if this uid never sends another message.
        await env.RATE_LIMIT_KV.put(`ratelimit:${uid}`, JSON.stringify(updated), {
            expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) + 3600
        });
    } catch (error) {
        console.error(`Failed to record token usage for ${uid}:`, error);
    }
}

function corsHeaders(origin, env) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
    const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '');
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        Vary: 'Origin'
    };
}

function jsonResponse(body, status, origin, env) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin, env) }
    });
}

// Rejects anything that isn't a valid, current, real Firebase ID token for
// THIS project - wrong project, expired, tampered, or missing entirely all
// throw here and the caller gets a flat 401 before Gemini is ever touched.
async function verifyFirebaseToken(request, env) {
    const match = (request.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
    if (!match) {
        throw new Error('missing bearer token');
    }

    const { payload } = await jwtVerify(match[1], JWKS, {
        issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
        audience: env.FIREBASE_PROJECT_ID,
        algorithms: ['RS256']
    });

    // jose checks exp/nbf automatically but not iat/auth_time - assert
    // those ourselves per Firebase's own verification checklist.
    const nowSec = Date.now() / 1000;
    if (typeof payload.sub !== 'string' || !payload.sub) {
        throw new Error('missing sub');
    }
    if (typeof payload.auth_time !== 'number' || payload.auth_time > nowSec) {
        throw new Error('bad auth_time');
    }
    if (typeof payload.iat !== 'number' || payload.iat > nowSec) {
        throw new Error('bad iat');
    }

    return { uid: payload.sub };
}

// includeId: only true for the currently-open group's tasks - solo tasks
// and other groups' tasks show an id too (harmless) but the prompt only
// ever tells the model ids from the CURRENT group are valid comment
// targets, so there's no need to withhold them elsewhere; keeping it
// explicit here anyway as a second, defensive layer.
function describeContextTask(task, includeId) {
    const parts = [String(task.text || '').slice(0, 200)];
    if (includeId && task.id) parts.push(`id=${String(task.id).slice(0, 80)}`);
    if (task.dueAt) parts.push(`due ${task.dueAt}`);
    if (task.matrix) parts.push(`matrix=${task.matrix}`);
    if (task.difficulty) parts.push(`difficulty=${task.difficulty}`);
    if (task.owner) parts.push(`assigned to ${task.owner}`);
    return parts.join(', ');
}

// Turns the client's read-only task snapshot (see brain-dump.js's
// gatherTaskContext) into a plain-text block appended to the system
// instruction, so it's clearly background information the model should
// use, not something the user said in the conversation itself. Every list
// is capped again here, defensively, regardless of what the client sent.
// currentGroupId (from the client's currentGroupId field) marks which one
// group, if any, teammateSuggestions/teammateComments may target.
function buildTaskContextBlock(taskContext, currentGroupId) {
    if (!taskContext || typeof taskContext !== 'object') {
        return '';
    }

    const solo = Array.isArray(taskContext.soloTasks) ? taskContext.soloTasks.slice(0, 150) : [];
    const groups = Array.isArray(taskContext.groups) ? taskContext.groups.slice(0, 20) : [];
    const hasAnyGroupTasks = groups.some((group) => Array.isArray(group?.tasks) && group.tasks.length > 0);

    // Still worth the full block (with roster) even with zero tasks
    // anywhere, if a group is currently open - a brand new group with
    // nobody's tasks in it yet can still have teammates worth suggesting
    // something to.
    if (solo.length === 0 && !hasAnyGroupTasks && !currentGroupId) {
        return '\n\nThe user has no other active tasks anywhere right now (solo or in any group).';
    }

    const lines = [
        "\n\nThe user's CURRENT existing workload, everywhere (not counting anything from this conversation) - use this to avoid proposing duplicates, to give real prioritization guidance, and to directly answer any question about their workload (in that case, propose no new tasks - just answer in \"reply\"):"
    ];

    if (solo.length > 0) {
        lines.push(`\nPersonal (solo) list, ${solo.length} active task(s):`);
        // includeId: true - solo tasks are always the user's own, so
        // there's no ownership ambiguity the way there is for a teammate's
        // task in a group. Task edits (see the EDITING EXISTING TASKS rule)
        // need a real id to reference here regardless of context.
        solo.forEach((task) => lines.push(`- ${describeContextTask(task, true)}`));
    }

    groups.forEach((group) => {
        const isCurrent = Boolean(currentGroupId) && group.id === currentGroupId;
        const tasks = Array.isArray(group?.tasks) ? group.tasks.slice(0, 150) : [];
        const roster = Array.isArray(group?.memberNames) ? group.memberNames.filter(Boolean) : [];
        const label = `\nGroup "${String(group.name || 'Unnamed').slice(0, 80)}"${isCurrent ? ' (currently open - you may suggest tasks or comment on tasks in THIS group only)' : ''}:`;
        lines.push(label);
        if (isCurrent && roster.length > 0) {
            lines.push(`Members: ${roster.join(', ')}`);
        }
        if (tasks.length === 0) {
            lines.push('(no active tasks right now)');
            return;
        }
        lines.push(`${tasks.length} active task(s):`);
        tasks.forEach((task) => lines.push(`- ${describeContextTask(task, isCurrent)}`));
    });

    return lines.join('\n');
}

// Turns the client's own read-only snapshot of users/{uid}/dustyMemory
// (see brain-dump.js's gatherDustyMemories) into a plain-text block, same
// "clearly background info, not something said in this conversation"
// framing as buildTaskContextBlock. Capped defensively again here
// regardless of what the client sent.
function buildMemoryBlock(memories) {
    const list = Array.isArray(memories) ? memories.slice(0, 60) : [];
    if (list.length === 0) {
        return '\n\nKnown facts about the user: none saved yet.';
    }
    const lines = ['\n\nKnown facts about the user (already saved - apply these actively per the MEMORY rule above, and do not re-propose any of these):'];
    list.forEach((memory) => lines.push(`- ${String(memory?.text || '').slice(0, 300)}`));
    return lines.join('\n');
}

function formatSignalMinutes(totalMinutes) {
    const minutes = Math.max(0, Math.round(Number(totalMinutes) || 0));
    if (minutes === 0) return '0m';
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours === 0) return `${remainder}m`;
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

// Turns the client's computed planning signals (see brain-dump.js's
// computeSoloPlanningSignals/computeGroupPlanningSignals) into a plain-text
// block, same "background info, not something said in this conversation"
// framing as buildTaskContextBlock/buildMemoryBlock. These are real
// arithmetic already done correctly client-side (totals, counts, date
// bucketing) - this function only formats them for the prompt, it never
// recomputes anything, so the numbers the model sees are exactly the
// numbers the app itself would show.
function buildPlanningSignalsBlock(signals, groupName) {
    if (!signals || typeof signals !== 'object') {
        return '';
    }
    const lines = [];

    const solo = signals.solo;
    if (solo && (solo.dueTodayCount > 0 || solo.dueWeekCount > 0 || (Array.isArray(solo.stalled) && solo.stalled.length > 0))) {
        lines.push('\n\nPERSONAL PLANNING SIGNALS (computed - use these exact numbers, per the FORWARD PLANNING rule above):');
        const todayNote = solo.dueTodayUnestimatedCount > 0
            ? ` (${solo.dueTodayUnestimatedCount} of those has/have no time estimate, so this is a floor, not the full picture)`
            : '';
        lines.push(`- Due today: ${solo.dueTodayCount} task(s), ${formatSignalMinutes(solo.dueTodayMinutes)} of estimated work${todayNote}.`);
        const weekNote = solo.dueWeekUnestimatedCount > 0
            ? ` (${solo.dueWeekUnestimatedCount} unestimated)`
            : '';
        lines.push(`- Due within 7 days: ${solo.dueWeekCount} task(s), ${formatSignalMinutes(solo.dueWeekMinutes)} of estimated work${weekNote}.`);
        if (Array.isArray(solo.stalled) && solo.stalled.length > 0) {
            lines.push('- Stalled (snoozed 3 or more times - likely a real blocker, not just a busy week):');
            solo.stalled.forEach((task) => lines.push(`  - "${task.text}" (snoozed ${task.snoozeCount} times, id=${task.id})`));
        }
    }

    const group = signals.group;
    if (group && (group.perMember?.length > 0 || group.deadlineCollisions?.length > 0 || group.pendingSuggestions?.length > 0)) {
        lines.push(`\n\nGROUP PLANNING SIGNALS for "${String(groupName || 'this group').slice(0, 80)}" (computed - use these exact numbers):`);
        if (Array.isArray(group.perMember) && group.perMember.length > 0) {
            lines.push('- Workload by member (active tasks, estimated effort, overdue count):');
            group.perMember.forEach((member) => {
                lines.push(`  - ${member.name}: ${member.activeTaskCount} active, ${formatSignalMinutes(member.totalEstimateMinutes)} estimated, ${member.overdueCount} overdue.`);
            });
        }
        if (Array.isArray(group.deadlineCollisions) && group.deadlineCollisions.length > 0) {
            lines.push('- Deadline collisions (2+ different people with something due the same day - often a shared external deadline worth coordinating on, not a coincidence):');
            group.deadlineCollisions.forEach((collision) => {
                const taskList = collision.tasks.map((t) => `"${t.text}" (${t.owner})`).join(', ');
                lines.push(`  - ${collision.date}: ${taskList}`);
            });
        }
        if (Array.isArray(group.pendingSuggestions) && group.pendingSuggestions.length > 0) {
            lines.push('- Pending suggestions still awaiting a response (avoid proposing something that overlaps with one of these):');
            group.pendingSuggestions.forEach((suggestion) => lines.push(`  - "${suggestion.text}" for ${suggestion.forUserName}`));
        }
    }

    return lines.join('\n');
}

function buildGeminiRequest(body) {
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];
    const contents = history.map((turn) => ({
        role: turn.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: String(turn.text || '').slice(0, 4000) }]
    }));

    const parts = [{ text: String(body.message || '').slice(0, 4000) }];
    if (Array.isArray(body.attachments)) {
        for (const attachment of body.attachments.slice(0, MAX_ATTACHMENTS)) {
            if (attachment && typeof attachment.mimeType === 'string' && typeof attachment.data === 'string') {
                parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
            }
        }
    }
    contents.push({ role: 'user', parts });

    const contextNote = body.context === 'group'
        ? 'These tasks are being proposed for a shared group to-do list.'
        : "These tasks are being proposed for the user's personal to-do list.";
    // clientTime is the USER'S OWN local wall-clock time and UTC offset
    // (see brain-dump.js's getClientTimeString) - spelled out explicitly
    // rather than just handing over the raw string, so "today"/"tomorrow"
    // always resolve against the user's actual calendar date, not UTC's.
    const timeNote = `The user's current local date and time, including their UTC offset, is: ${body.clientTime || new Date().toISOString()}. Treat this as their "now" - resolve every relative date ("today", "tomorrow", "next Friday") against THIS date, in THIS timezone, not UTC. ${contextNote}`;
    const currentGroupId = typeof body.currentGroupId === 'string' ? body.currentGroupId : null;
    const taskContextBlock = buildTaskContextBlock(body.taskContext, currentGroupId);
    const memoryBlock = buildMemoryBlock(body.memories);
    const currentGroupForSignals = currentGroupId && Array.isArray(body.taskContext?.groups)
        ? body.taskContext.groups.find((group) => group?.id === currentGroupId)
        : null;
    const planningSignalsBlock = buildPlanningSignalsBlock(body.taskContext?.signals, currentGroupForSignals?.name);
    // Only meaningful with a real currently-open group - see
    // TEAMMATE_INSTRUCTION's own comment for why this is trimmed rather
    // than always sent.
    const includeTeammateFeatures = body.context === 'group' && Boolean(currentGroupId);
    const teammateInstruction = includeTeammateFeatures ? TEAMMATE_INSTRUCTION : '';

    const properties = {
        reply: { type: 'STRING' },
        tasks: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    text: { type: 'STRING' },
                    matrix: { type: 'STRING', enum: ['do', 'schedule', 'delegate', 'eliminate'] },
                    taskType: { type: 'STRING', enum: ['open', 'timeboxed'] },
                    // Deliberately plain STRING, not INTEGER+enum - Gemini's
                    // enum support is far more reliable on STRING, and none
                    // of this is trusted without client-side sanitization
                    // anyway (see getValidDifficultyLevel/parseDurationMinutes
                    // in task-shared.js), so there's no cost to sidestepping it.
                    difficulty: { type: 'STRING' },
                    estimateMinutes: { type: 'STRING', nullable: true },
                    dueAt: { type: 'STRING', nullable: true },
                    scheduledAt: { type: 'STRING', nullable: true },
                    subtasks: { type: 'ARRAY', items: { type: 'STRING' } }
                },
                // dueAt/subtasks required (not just optional) so the model
                // must explicitly commit to a value (even null/[]) every
                // time instead of silently skipping the reasoning - required
                // + nullable/empty-allowed still means "always present,
                // considered", not "always populated with something real".
                required: ['text', 'matrix', 'taskType', 'dueAt', 'subtasks']
            }
        },
        // See the "MEMORY" section of SYSTEM_INSTRUCTION - available
        // regardless of context (solo or group), unlike the two below.
        memoryProposals: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    text: { type: 'STRING' }
                },
                required: ['text']
            }
        },
        // See the "EDITING EXISTING TASKS" rule in SYSTEM_INSTRUCTION -
        // available regardless of context (solo or group), same as
        // memoryProposals. Every field but taskId/taskPreview is OPTIONAL
        // (nullable, not required) - unlike "tasks" above (a brand new task
        // needs every field decided one way or another), an edit should
        // only ever carry the specific fields actually changing. Omitted
        // means "leave as-is"; an explicit null on dueAt/scheduledAt means
        // "clear this deadline/schedule".
        taskEdits: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    taskId: { type: 'STRING' },
                    taskPreview: { type: 'STRING' },
                    matrix: { type: 'STRING', enum: ['do', 'schedule', 'delegate', 'eliminate'], nullable: true },
                    difficulty: { type: 'STRING', nullable: true },
                    dueAt: { type: 'STRING', nullable: true },
                    scheduledAt: { type: 'STRING', nullable: true },
                    completed: { type: 'BOOLEAN', nullable: true }
                },
                required: ['taskId', 'taskPreview']
            }
        },
        // See the "Whenever reply ends on a question..." rule in STEP 3 -
        // the tappable-chip version of whatever multiple-choice-style
        // question "reply" just asked, if any. Available regardless of
        // context, same as memoryProposals.
        quickReplies: { type: 'ARRAY', items: { type: 'STRING' } }
    };
    const requiredProperties = ['reply', 'tasks', 'memoryProposals', 'taskEdits', 'quickReplies'];

    // Both only ever populated when a group is marked "currently open" -
    // left out of the schema ENTIRELY otherwise (not just told to leave
    // them empty), so Gemini has less to reason about and less to output
    // on every solo/no-group call. See TEAMMATE_INSTRUCTION above.
    if (includeTeammateFeatures) {
        properties.teammateSuggestions = {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    forMemberName: { type: 'STRING' },
                    text: { type: 'STRING' },
                    matrix: { type: 'STRING', enum: ['do', 'schedule', 'delegate', 'eliminate'] },
                    difficulty: { type: 'STRING' },
                    dueAt: { type: 'STRING', nullable: true }
                },
                required: ['forMemberName', 'text', 'matrix', 'dueAt']
            }
        };
        properties.teammateComments = {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    taskId: { type: 'STRING' },
                    taskPreview: { type: 'STRING' },
                    memberName: { type: 'STRING' },
                    text: { type: 'STRING' }
                },
                required: ['taskId', 'taskPreview', 'memberName', 'text']
            }
        };
        requiredProperties.push('teammateSuggestions', 'teammateComments');
    }

    return {
        systemInstruction: { parts: [{ text: `${SYSTEM_INSTRUCTION}${teammateInstruction}\n\n${timeNote}${taskContextBlock}${planningSignalsBlock}${memoryBlock}` }] },
        contents,
        generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
            // Wrapped in an OBJECT (not a bare array root) specifically so
            // `reply` and `tasks` can travel together in one call. Types
            // are UPPERCASE strings - not standard lowercase JSON Schema.
            // properties/requiredProperties built above - trimmed to skip
            // teammateSuggestions/teammateComments entirely outside a
            // currently-open group, rather than always including them.
            responseSchema: {
                type: 'OBJECT',
                properties,
                required: requiredProperties
            }
        }
    };
}

async function callGemini(body, env) {
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Header, not a ?key= query param - keeps it out of any
                // URL-based logging, even though this call is Worker-side only.
                'x-goog-api-key': env.GEMINI_API_KEY
            },
            body: JSON.stringify(buildGeminiRequest(body))
        }
    );

    if (response.status === 429) {
        // Previously swallowed - logged now so a real rate-limit (which
        // free-tier quota, per-minute vs. per-day) is actually visible in
        // `wrangler tail` instead of just "rate limited".
        const text = await response.text().catch(() => '');
        console.error('Gemini rate limited:', text);
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
    }
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error('Gemini error:', response.status, text);
        const error = new Error('gemini request failed');
        error.status = 502;
        throw error;
    }

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
        const error = new Error('empty gemini response');
        error.status = 502;
        throw error;
    }

    const parsed = JSON.parse(raw);
    return {
        reply: typeof parsed.reply === 'string' ? parsed.reply : '',
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        teammateSuggestions: Array.isArray(parsed.teammateSuggestions) ? parsed.teammateSuggestions : [],
        teammateComments: Array.isArray(parsed.teammateComments) ? parsed.teammateComments : [],
        memoryProposals: Array.isArray(parsed.memoryProposals) ? parsed.memoryProposals : [],
        taskEdits: Array.isArray(parsed.taskEdits) ? parsed.taskEdits : [],
        quickReplies: Array.isArray(parsed.quickReplies) ? parsed.quickReplies : [],
        // Real usage for this exact call, straight from Gemini itself -
        // what the rate limiter actually charges against the user's
        // session window (see recordTokenUsage). Not sent on to the
        // client as-is; the fetch handler pulls it out separately.
        tokensUsed: Number(data?.usageMetadata?.totalTokenCount) || 0
    };
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';
        // Temporary - pinpointing where a slow request's time actually
        // goes (auth/KV/Gemini/KV) rather than guessing. Safe to strip
        // once that's confirmed; visible live via `wrangler tail`.
        const t0 = Date.now();

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
        }
        if (request.method !== 'POST') {
            return jsonResponse({ error: 'method not allowed' }, 405, origin, env);
        }

        const contentLength = Number(request.headers.get('Content-Length') || 0);
        if (contentLength > MAX_BODY_BYTES) {
            return jsonResponse({ error: 'request too large' }, 413, origin, env);
        }

        let uid;
        try {
            ({ uid } = await verifyFirebaseToken(request, env));
        } catch (error) {
            console.error('Auth rejected:', error.message);
            return jsonResponse({ error: 'unauthorized' }, 401, origin, env);
        }
        const tAuth = Date.now();

        // Checked right after identity, before spending any effort parsing
        // the body or calling Gemini - see getRateLimitState's own comment
        // for why this exists independent of Gemini's own quota.
        const rateLimitState = await getRateLimitState(uid, env);
        const tRateRead = Date.now();
        if (rateLimitState && rateLimitState.tokensUsed >= RATE_LIMIT_TOKEN_BUDGET_PER_WINDOW) {
            return jsonResponse(
                {
                    error: 'rate_limited',
                    reply: "You've used up this session's message budget - it resets soon.",
                    resetsAt: new Date(rateLimitState.windowStartedAt + RATE_LIMIT_WINDOW_MS).toISOString(),
                    rateLimit: rateLimitSnapshot(rateLimitState)
                },
                429,
                origin,
                env
            );
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ error: 'invalid json body' }, 400, origin, env);
        }

        try {
            const { tokensUsed, ...result } = await callGemini(body, env);
            const tGemini = Date.now();
            await recordTokenUsage(uid, env, rateLimitState, tokensUsed);
            const tKvWrite = Date.now();
            console.log(
                `Brain dump timing for ${uid}: auth=${tAuth - t0}ms kvRead=${tRateRead - tAuth}ms `
                + `gemini=${tGemini - tRateRead}ms kvWrite=${tKvWrite - tGemini}ms total=${tKvWrite - t0}ms `
                + `tokensUsed=${tokensUsed}`
            );
            const updatedState = rateLimitState
                ? { ...rateLimitState, tokensUsed: rateLimitState.tokensUsed + Math.max(0, tokensUsed) }
                : null;
            return jsonResponse({ ...result, rateLimit: rateLimitSnapshot(updatedState) }, 200, origin, env);
        } catch (error) {
            console.error(`Brain dump request failed for ${uid}:`, error);
            if (error.status === 429) {
                // Almost always the shared free-tier DAILY quota, not a
                // brief per-minute throttle (one Gemini API key/quota pool
                // is shared across every user of the app, not per-account)
                // - resetsAt lets the client say when instead of the vague
                // "try again in a bit" that undersold how long this can
                // actually last.
                return jsonResponse(
                    {
                        error: 'busy',
                        reply: "Dusty's hit her shared daily message limit - try again later.",
                        resetsAt: getNextQuotaResetIso(),
                        rateLimit: rateLimitSnapshot(rateLimitState)
                    },
                    429,
                    origin,
                    env
                );
            }
            return jsonResponse({ error: 'brain dump failed', rateLimit: rateLimitSnapshot(rateLimitState) }, 502, origin, env);
        }
    }
};
