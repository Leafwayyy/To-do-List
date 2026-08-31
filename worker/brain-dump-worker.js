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

const GEMINI_MODEL = 'gemini-2.5-flash';
// Keeps one oversized attachment from burning a disproportionate share of
// the shared daily Gemini free-tier quota - checked before Gemini is ever
// called, not enforced by Gemini itself.
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY_TURNS = 10;
const MAX_ATTACHMENTS = 5;

const SYSTEM_INSTRUCTION = `You are a task-extraction assistant for a to-do list app. The user will ramble, brain-dump, or attach images/PDFs/text about what's going on in their life. Your only job is to find concrete, actionable tasks in what they said or attached, and propose them - never invent unrelated tasks, and don't propose something that isn't a real actionable item (general venting, background info, or something already done isn't a task).

For each task, infer:
- text: a short, clear task description (not a copy of their whole message)
- matrix: 'do' (important AND urgent), 'schedule' (important, not urgent), 'delegate' (urgent, not important to them personally), or 'eliminate' (neither) - your best judgment of the Eisenhower quadrant
- taskType: 'timeboxed' if a duration is stated or clearly implied, otherwise 'open'
- difficulty: your best guess, 1 (very easy) to 5 (very hard), as a string
- estimateMinutes: a number of minutes as a string if taskType is 'timeboxed' and a duration is inferable, otherwise null
- dueAt: an ISO 8601 datetime string if a deadline is stated or implied (resolve relative dates like "tomorrow" or "next Friday" against the current time given below), otherwise null
- scheduledAt: an ISO 8601 datetime string ONLY if the user said specifically when they plan to WORK ON it (distinct from when it's due), otherwise null

Also write a short, friendly one-or-two-sentence reply acknowledging what you found (or, if nothing task-like was in the message, say so plainly rather than inventing something).`;

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
    const timeNote = `The current date/time is ${body.clientTime || new Date().toISOString()}. ${contextNote}`;

    return {
        systemInstruction: { parts: [{ text: `${SYSTEM_INSTRUCTION}\n\n${timeNote}` }] },
        contents,
        generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json',
            // Wrapped in an OBJECT (not a bare array root) specifically so
            // `reply` and `tasks` can travel together in one call. Types
            // are UPPERCASE strings - not standard lowercase JSON Schema.
            responseSchema: {
                type: 'OBJECT',
                properties: {
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
                                scheduledAt: { type: 'STRING', nullable: true }
                            },
                            required: ['text', 'matrix', 'taskType']
                        }
                    }
                },
                required: ['reply', 'tasks']
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
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : []
    };
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') || '';

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

        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ error: 'invalid json body' }, 400, origin, env);
        }

        try {
            const result = await callGemini(body, env);
            return jsonResponse(result, 200, origin, env);
        } catch (error) {
            console.error(`Brain dump request failed for ${uid}:`, error);
            if (error.status === 429) {
                return jsonResponse(
                    { error: 'busy', reply: 'The AI is busy right now - try again in a bit.' },
                    429,
                    origin,
                    env
                );
            }
            return jsonResponse({ error: 'brain dump failed' }, 502, origin, env);
        }
    }
};
