# Organization, Roles & Shared Tasks Plan

> **STATUS (2026-10-30): ALL phases are CODED, including per-person access (assign / manage folders) and the 15-minute decline window. VERIFIED so far: every script passes a syntax check; 26 solo checks and 37 group checks pass in a simulated browser (jsdom) against the real code (quick-add chips, `/` menu, shortcuts, folder manager and sorter, roles, access scoping, assign fan-out incl. partial failure and retry, decline window, decline notices, the Roles & access dialog). NOT verified: anything against real Firebase (sign-in, Firestore, App Check), the security rules in the Firebase emulator (no Java on this machine), visual layout in a real browser, and the worker deploy. The updated `firestore.rules` are NOT published, the worker is NOT redeployed, and nothing is committed.**
> A review of the rules found and fixed one real risk: batched writes may only make ~20 document lookups, so the assign rule was cut from 3 lookups per task to 2 (via `canCreateAssigned`) and the group folder sorter now writes in batches of 15 instead of 400.
> Deliberately not built: Dusty assigning tasks to people (an AI action reaching other users; Dusty only proposes a folder, which you confirm on the review card), "any one of us" completion, creator-sync editing of shared copies, and auto re-showing the tutorial to existing users (they can open it from the Tutorial button).
> Touched: `folders.js`, `quickadd.js`, `group/roles.js`, `group/assign.js` (new); `app.html`, `group/index.html`, `script.js`, `group/group.js`, `group/groups-data.js`, `settings.js`, `brain-dump.js`, `worker/brain-dump-worker.js`, `style.css`, `firestore.rules`, `auth-gate.js` (one console.error).
> Known limits: a decline notice is dismissed per device; assigning to many people is sent in chunks of 8, so a network failure partway can reach only some people and the app says exactly who was missed; an admin can still put many tasks on a member (they can decline within 15 minutes or delete, and the assigner is told either way; no rate limit is possible in rules); a member who leaves and rejoins keeps any old grant until an owner/admin next saves Roles & access.
> **Reviews run (2026-10-30), all findings fixed:** securitymaxxing authz + injection + diff + secrets + llm, and a code review of commit 42b9ac7. Fixed: stale access grants after a leave/rejoin (grants now bound to the member's join time, and joins must write a fresh server-stamped `memberJoinedAt`), backdatable decline window (`assignedAt == request.time`), hierarchy inversion (granted assigners can't assign to owner/admins), members attaching tasks to others' shared cards, prompt injection through shared folder names and teammate task text (flattened, framed as data), memory poisoning (Dusty auto-saves a memory only when the user's own words support it, otherwise asks "Remember this?"), the Group folder dropdown resetting on every snapshot, silent drop of assigns to a person who left, role-scope mismatch in the `/` menu, retry-after-landed-batch, record naming people who never got a copy, and duplicate folder listeners. 37 solo + 55 group + regex/prompt/LLM checks pass in a simulated browser. Still open: list-element sizes in `folders`/`roles`/`participantNames` are only size-capped (rules can't loop); the repo is PUBLIC (no secrets found; revoke the App Check debug token that was pasted in chat); Gemini billing-tier / data-use setting should be confirmed against the privacy policy claim.
> **Announcing future updates:** add ONE entry at the top of `WHATS_NEW_RELEASES` in `whatsnew.js` (new unique `id`, short plain-language items), then bump the `?v=` on the `whatsnew.js` script tags in `app.html` and `group/index.html`. Returning users see a one-time "What's new" popup; brand-new accounts skip it (they get the tutorial); everyone can reopen the full log from the gift button in the header.
> Sits beside `plan.md` (completed UI/UX plan) and `availability-plan.md`.
> Decisions marked **[DECIDED]** came from the owner's answers on 2026-10-30.
> Decisions marked **[DEFAULT]** are my recommendation and are open to change (see section 12).

---

## 1. What we're solving

| # | Problem (owner's words, restated) | Who it hurts | Severity |
|---|-----------------------------------|--------------|----------|
| P1 | Creating a task without the Dusty chatbot means opening the Prioritize panel and filling in every field | Everyone, every day | High (daily friction) |
| P2 | Tasks are organized by priority, focus and due date but not by category. As the list grows it becomes one long pile | Solo and group users with 20+ tasks | High (grows over time) |
| P3 | In a professional group, people have roles and jobs, but the app has only owner / admin / member. There is no way to see "the Designer's tasks" | Work-style groups | Medium |
| P4 | Suggested tasks often sit unaccepted. Owners and admins have no way to say "this is assigned" | Owners/admins who need work done | High |
| P5 | When several people do the same task, suggesting it one person at a time is slow, and showing it per person in "Everyone" makes duplicates | Any group with recurring shared work | High |
| P6 | Tutorials will be out of date once the above ships | New users | Required follow-up |

### Root causes (from reading the code)

- **P1.** A quick-add parser already exists (`parseQuickAddPhrase` in `task-shared.js:545`), but it only understands dates and times ("tomorrow 5pm", "in 2 hours"). Priority, difficulty, steps and (in groups) assignment can only be set through the form or the chatbot.
- **P2.** Task objects have no category field. They hold `matrix`, `difficulty`, `taskType`, `dueAt`, `recurrence`, `scheduledAt`, `subtasks`. Solo tasks live in `users/{uid}/tasks/{taskId}`.
- **P3.** A group document has `ownerId`, `adminIds`, `memberIds`, `memberNames` and nothing role-like.
- **P4.** `suggestTaskForMember` (`group/group.js:145`) writes a `suggestions` doc with `status: 'pending'`. Only the target can accept, and accepting creates the task. `firestore.rules:454-460` requires `request.resource.data.ownerId == request.auth.uid` on task create, so **nobody can currently create a task on someone else's behalf, even an owner**.
- **P5.** A group task has exactly one `ownerId`, and only that person can edit it (`firestore.rules:511-562`). "Everyone" is a plain filter over all task docs (`group.js:4557`), so five copies of the same chore are five separate rows. Suggestions are also one doc per target (`forUserId`).

---

## 2. Research: how other tools solve these

Findings are summarized; the sources are linked at the bottom. Where a claim came from a forum or vendor blog I say so. Treat those as hints, not facts.

### 2.1 Quick-add and slash commands
- **Todoist** uses typed symbols in one text box: `#Project`, `@label`, `p1`-`p3` for priority, plus natural dates. Projects and labels must already exist (a forum report says it will not create them). Takeaway: symbols are fast for power users but are exactly what you told us is too much to remember, so we do not copy them. We keep the useful idea (one box, instant result) without the codes.
- **GitLab's** research on slash commands in Duo Chat found most participants *did not notice* the "type /" hint and fell back to plain language. Takeaway: a slash menu alone is not discoverable. It needs a visible button and a keyboard shortcut next to it.
- **Linear** found Ctrl/Cmd+K is not mobile-friendly and added a two-finger tap. Takeaway: every keyboard shortcut needs a touch alternative (your app is a PWA with a manifest, so phones matter).
- **Cloverpop's** Slack write-up says the best fix for typed commands is making the app usable without typing a command at all, and keeping commands short.

**Design consequence:** build three entry points that all feed one parser: (a) plain words plus suggestion chips, (b) a `/` menu that adds chips, (c) the existing form. No symbols to memorize (owner feedback 2026-10-30).

### 2.2 Folders vs labels
- Todoist separates the two: projects (one place) and labels (many tags). Many teams over-tag and end up with labels nobody uses (practitioner consensus, not a studied result).
- **[DECIDED]** one folder per task, with a color. Simple to explain, simple to filter, hard to misuse. Tags can be added later without a data migration, because a folder is just a field.

### 2.3 Shared tasks (the duplicate problem)
- **Asana** lets a task have only *one* assignee. Its recommended answer for shared work is either subtasks per person or an "assign identical copies" option, and users in the forum say this is painful at scale (one reported re-entering 50 names). Multi-homing controls where a task appears, not who owns it.
- Takeaway: Asana proves the two bad extremes. Fully separate copies with no link give you duplicates and no group view. A single task with one done-state cannot say who has finished.
- **Our approach (section 5.5):** keep one task document *per person* (which matches our security rules) but give them a shared `sharedId` link, and have "Everyone" collapse them into one card. That is "Asana's per-person copies" plus the group view Asana users ask for.

### 2.4 Assigning without an accept step
- The Harvard Business Review work by Greenberg, Morwitz and Munz (summarized on EBSCO and Bocconi's repository) says people commit to assigned work when it feels *final*, *fairly decided*, and they keep *some* choice. A forced accept click is not what produces buy-in.
- Forum practice splits between "accepted unless declined" and explicit accept. A Hospitable feature request asks for auto-accept for trusted crews while keeping decline for conflicts.
- A small master's thesis found imposed non-preferred tasks lowered performance. Small study, weak evidence.
- **[DECIDED]** admin-assigned tasks appear on the assignee's list immediately, with a visible "Assigned by X" badge and a **Decline** option. That is "accepted unless declined", which is what the research supports.

### 2.5 Sources
- Todoist Quick Add help: https://todoist.com/help/articles/115001745265
- Todoist syntax overview (third party): https://www.usecarly.com/blog/how-to-use-natural-language-in-todoist/
- Asana single-assignee limit and workarounds: https://forum.asana.com/t/assign-multiple-assignees-on-one-task/1176 and https://forum.asana.com/t/assigning-multiple-assignees-to-one-task/86702
- GitLab slash command discoverability research: https://gitlab.com/gitlab-org/gitlab/-/issues/489832
- Slack app UX (Cloverpop): https://www.cloverpop.com/blog/six-ux-challenges-when-building-slack-apps-and-how-we-fixed-them
- Linear command menu on mobile: https://linear.app/changelog/2019-11-04-better-slack-notifications
- HBR "When you have to assign work no one wants to do": https://www.ebsco.com/articles/psychology/d5fa01da-bfa7-5f63-8eef-dbae28323bbc/when-you-have-to-assign-work-no-one-wants-to-do
- Asana accept/decline etiquette thread: https://forum.asana.com/t/assignment-and-due-date-etiquette/1900
- Auto-accept request (Hospitable): https://feedback.hospitable.com/p/operations-auto-accept-option-for-task-assignments

---

## 3. Guiding principles

1. **Additive only.** Every new field is optional. Old tasks, old groups and old clients keep working with no backfill and no migration.
2. **Rules before client.** Publish `firestore.rules` changes first (they are backward compatible), then ship client code. The project has already been bitten by unpublished rules (`describeGroupWriteError` exists for exactly that).
3. **Fail visible.** A task never silently lands in the wrong place. Missing folder, deleted role or declined assignment each have a defined fallback (section 8).
4. **One parser, many doors.** Plain words, suggestion chips, slash menu, form, and Dusty all produce the same draft object.
5. **Least privilege.** Owners and admins get the new powers. Members never gain the ability to touch each other's tasks beyond what they have today.

---

## 4. Feature overview and decisions

| Feature | Solo | Group | Status |
|---------|------|-------|--------|
| Folders (one per task, colored) | Yes | Yes (admin-managed, shared) | **[DECIDED]** |
| Roles = job title people are grouped under | n/a | Yes, owner/admin-managed, no extra permissions | **[DECIDED]** |
| Quick-add: plain words + suggestion chips + `/` menu + shortcut (no symbol codes) | Yes | Yes (plus assign chips) | **[DECIDED]** simplified 2026-10-30 |
| Direct assign by owner/admin with Decline | n/a | Yes | **[DECIDED]** |
| Shared tasks: one card, each person checks off their own | n/a | Yes | **[DECIDED]** |
| Multi-person suggestion (everyone / role / pick) | n/a | Yes | **[DEFAULT]** |
| Tutorials updated | Yes | Yes | Required |

---

## 5. Detailed design

### 5.1 Folders

**Data**
- Solo: `users/{uid}` doc gets `folders: [{id, name, color, order}]` (cap 30). Task gets optional `folderId`.
- Group: `groups/{g}` doc gets `folders: [...]` (cap 30), managed by owner and admins. Group task gets optional `folderId`.
- Built-in "Unfiled" is not stored. It is "no folderId, or a folderId that is not in the list".

**Behaviour**
- Folder chip row above the task list: `All | Work | School | Unfiled | + New`. Selecting one filters. It stacks with the existing priority/focus/due sorting rather than replacing it.
- Deleting a folder does **not** rewrite tasks. Tasks pointing at it simply render as Unfiled. This is deliberate: in groups only the task owner can edit a task, so an admin cannot cascade. It also makes delete trivially reversible (re-create a folder with the same id by undoing within the session).
- Rename and recolor touch only the folder list, never tasks.
- Folder ids are short random strings, never names, so renames are safe.

**Rules (group)**: new owner/admin-only update branch on the group doc with `diff().affectedKeys().hasOnly(['folders'])`, `folders is list`, `size() <= 30`, each name length-capped. Follows the existing `name` / availability-range branch style.

### 5.2 Roles (group only)

**[DECIDED]** A role is a job title that tasks are grouped under. It carries **no permissions**. Owner/admin/member stay exactly as they are.

**Data (on the group doc)**
- `roles: [{id, name, color}]` (cap 20).
- `memberRoles: {uid: roleId}` map. **[DEFAULT]** one role per member in v1. (Open question Q1.)

**Behaviour**
- Settings overlay gets a Roles section (create / rename / delete, assign to members). Owner and admin only.
- Team tab shows each member's role as a small tag next to their name.
- Everyone view gets a **Group by: Person | Role | Folder** toggle. "By role" groups tasks under the *assignee's current role*.
- A task never stores its role. It is derived at render time from `memberRoles[task.ownerId]`. That avoids stale data when roles change, and it means no task writes are needed when someone is promoted or a role is deleted.
- Deleting a role: members with that role show as "No role". Nothing else changes.
- A kicked or departed member's `memberRoles` entry is ignored (not in `memberIds`) and cleaned up the next time an admin saves roles.

**Rules**: owner/admin-only branch, `hasOnly(['roles','memberRoles'])`, every `memberRoles` key must be in `memberIds` (checked with the same prefix/hasAll style used for joins), role ids must exist in `roles`.

### 5.2b Per-person access (added 2026-10-30, owner request)

Roles stay pure labels (decision above). Real powers are granted to a SPECIFIC PERSON by the owner or an admin, never inferred from a role:

- `groups/{g}.memberPerms = { uid: { assign: 'all' | 'role', folders: true } }`, written only by owner/admin (the Roles & access dialog, same atomic write as roles).
- **Assign:** `'all'` = may assign to anyone; `'role'` = may assign only to people who share THEIR role (both must have a role set and it must match, enforced in `firestore.rules` `canAssignTo`, and mirrored client-side). No assign grant = may only Suggest.
- **Manage folders:** may create/rename/delete the group's folders. Does NOT include roles, kicking, promoting or settings, which stay owner/admin only.
- Owners and admins always have everything. A right exists only when the stored value is exactly `'all'`, `'role'` or `true`, so a garbage value grants nothing.
- Known gotcha: a stale entry for someone who left is ignored while they're not a member, but if they rejoin with the same account their old grant applies again until an owner/admin next saves the dialog (which prunes non-members). Review access after re-adding someone.
- Assignment records (`/assignments`) can be created by anyone with any assign right; the per-person scope is enforced on each task created, because rules can't loop over the participant list.

### 5.3 Quick-add: plain words, chips, and a `/` menu (no symbols to learn)

**Rule: nothing the user must memorize.** There are no `#`, `!`, `~` or `@` codes. The only "syntax" is ordinary words people already type, plus one character, `/`, which opens a menu you pick from.

One parser, extended from `parseQuickAddPhrase`. It lives in `task-shared.js`, which both solo and group already load, so both get it with one edit.

**1. Plain words (already works, slightly extended)**
- Dates and times as today: `tomorrow 5pm`, `in 2 hours`, `next friday`.
- Repeat: `every week`, `daily`, `every friday` (needs a date, same rule as today).
- Nothing else is parsed from the text. The title stays exactly what you typed minus the date words.

**2. Suggestion chips (the app notices, you tap)**
- While typing, if a word matches something real, a chip appears under the input: **File under School?** (word matched a folder name), **Assign to Sam?** (group, word matched a member), **High priority?** (words like `urgent`, `asap`, `important`).
- Tap to accept, ignore to dismiss. Accepted chips become part of the task; the word is left in the title. Nothing is ever applied silently.
- Matching is case-insensitive against *existing* folders/members/roles only, whole word, and only suggests when unambiguous. Unknown words do nothing, so there are no "unknown token" errors to design for.

**3. The `/` menu (for everything else)**
- Typing `/` (at the start or after a space), or tapping the always-visible **/** button in the input, opens a short list in plain words: **Due date, Folder, Priority, Difficulty, Repeat, Steps**, and in groups **Assign to, Share with**.
- Pick one, then pick a value from a small list (your folders, your teammates). It becomes a **chip** shown beside the input (`📁 School ✕`). The `/` and the command name are never left in the text, so there is nothing to clean up or get wrong.
- Chips are removable with ✕. Arrow keys + Enter + Esc; `combobox`/`listbox` roles for screen readers.

**4. Live preview**
- A single line under the input shows what will be created: `School · Tomorrow 5:00 PM · High`. The user sees the outcome *before* pressing Add.

**Shortcuts and touch**
- **N** (when not typing in a field) focuses quick-add. **Ctrl/Cmd+K** opens quick-add as an overlay from anywhere. A "?" button lists them. Shortcuts can be turned off in Settings.
- Touch: visible **+** button opens the same overlay; visible **/** button opens the menu. Nothing depends on a keyboard shortcut.

**Interaction with existing pieces**
- Explicit form fields and chips win over date guesses, same precedent as "an explicit manual deadline always wins over a quick-add guess" (`group.js:8193`).
- The Prioritize panel and Dusty are unchanged in purpose. Dusty's drafts gain `folderId` (see 5.8).

### 5.4 Direct assignment by owners and admins

**[DECIDED]** assigned tasks appear immediately with a **Decline** option.

**Mechanism (needs a rules change, which is the key technical risk)**
- Today task create requires `ownerId == request.auth.uid`. We add a second create branch: the writer is the group's owner or an admin (existing helper `isOwnerOrAdmin`), the new task's `ownerId` is a current member, and the doc carries `assignedBy == request.auth.uid` and `assignedByName`. No other path may set `assignedBy` on someone else's behalf. Tasks created by the owner themselves must not carry `assignedBy`.
- Task fields: `assignedBy`, `assignedByName`, `assignedAt` (server timestamp), `assignmentStatus: 'assigned' | 'kept'`.
- Recipient sees: a normal task plus an "Assigned by Sam" badge and **Decline**. **[DEFAULT]** Decline is available until they check anything off or edit the task, with no clock. (Q2: add a time limit?)
- **Decline** removes the task from their list (they are the owner, so the existing delete rule applies) and records the outcome so the assigner is told. Outcome record: `groups/{g}/assignments/{sharedId}` map key `declined.{uid}` (see 5.5), using the same "only my own key in a map" diff technique already used for `memberJoinedAt` and `catchUpDismissed`.
- Assigner sees a "Sam declined 'Write report'" notification in the same place suggestion outcomes appear today (`getUnacknowledgedSuggestionOutcomes` pattern).
- Normal members **cannot** assign. They keep using Suggest (which still needs accepting). That keeps today's trust model for peers and gives authority only to owners/admins, which is what you asked for.

**Why not reuse suggestions with an `autoAccept` flag?** It would need the recipient's browser to be open to turn it into a task, so assigned work would appear late or not at all. Direct creation is immediate and atomic.

### 5.5 Shared tasks (the duplicates answer)

**The model: one task per person, linked by `sharedId`, shown as one card in Everyone.**

Why this and not "one document with a participants list"? Our rules allow only a task's owner to edit it. A single shared document would force members to edit a doc they do not own, requiring a much wider and riskier rule. Per-person docs keep every existing guarantee (own checkbox, own steps, own history, existing streak and stats code) and need only the creation rule from 5.4.

**Data**
- Each participant's task doc: `sharedId` (random id), `sharedBy`.
- Bundle doc `groups/{g}/assignments/{sharedId}`: `{createdBy, createdByName, text, participants:[{uid,name}], createdAt, declined:{uid:ts}}`. Optional but is what carries the Decline outcome and a stable "who was in this" list even if copies are deleted.

**Creation (the "easier way")**
- In the group composer, an **Assign to** control: *Just me | Pick people… | A role | Everyone*. Same via the `/` menu's Assign to / Share with chips, or the **Assign to Sam?** suggestion chip.
- Owner/admin: creates all copies at once in **one `writeBatch`** (atomic, all or nothing; group cap is 50 members, batch limit is 500 writes, so this always fits).
- Regular member: the same control produces **suggestions** (one per target, all sharing a `sharedId`), since they cannot create for others. Each person still accepts individually. Accepted ones join the bundle.
- Targets are fixed at creation. **New members who join later do not get the task automatically.** (Q4)

**Display**
- **Your list:** your own copy, normal row, with a small avatar stack "You, Sam +2".
- **Everyone view:** copies with the same `sharedId` collapse to **one card**: title, avatar chips with done state (✓ or empty ring), and "2 of 4 done". Expanding shows each person's status and steps. Clicking your own chip toggles your own checkbox only.
- Group-by-role/folder views collapse the same way.
- Collapsing happens client-side in the render step that already exists (`group.js:4557` filter), keyed on `sharedId`. No new listener, no server fan-in.

**Completion semantics** **[DECIDED]** each person checks off their own. The card shows progress. **[DEFAULT]** creator may later choose "any one of us" for a task. Out of scope for v1 (Q5).

**Editing a shared task** **[DEFAULT]** v1: each person's copy is independent after creation (text, due date, steps). The card shows the creator's original title. Optional v1.1: a `sharedBy`-only rule allowing the creator/admin to update `text`, `dueAt`, `matrix`, `folderId` on copies with the matching `sharedId`. Called out in Q3 because it widens the rules.

**Deleting**: a person deleting their copy leaves the others untouched and the card shrinks. Creator deleting "for everyone" is not possible in v1 (see above). The bundle doc keeps the participant list.

### 5.6 Multi-person suggestions
Same composer as 5.5. Nothing new beyond the shared `sharedId` on each suggestion doc and suggestion UI grouping "You suggested this to 4 people: 2 accepted, 1 dismissed, 1 pending" instead of four rows.

### 5.7 Notifications and history
- Assignment, decline and completion events reuse the existing `history` and suggestion-outcome patterns. No new notification system.
- History entries gain optional `folderId` and `sharedId` so "Recently finished" can show shared completions as one line later. Not required for v1.

### 5.8 Dusty / Brain Dump
- `worker/brain-dump-worker.js` prompt gets the user's folder names (and in groups, role and member names). Draft tasks gain an optional `folder` name that is resolved client-side to a `folderId`. Unknown names are dropped and the task goes to Unfiled.
- Dusty can propose assignments only for owner/admin sessions, and always shows an Assigned-to line in the review card the user confirms. The AI never writes directly.
- Treat all AI output as untrusted (already the pattern: "NOT trusted" in `commitAiTasksGroup`). Folder and member ids must be validated against the real lists before any write.

---

## 6. Data model summary (all optional)

```
users/{uid}                    + folders[{id,name,color,order}]
users/{uid}/tasks/{id}         + folderId
groups/{g}                     + folders[], roles[{id,name,color}], memberRoles{uid:roleId}
groups/{g}/tasks/{id}          + folderId, sharedId, sharedBy,
                                 assignedBy, assignedByName, assignedAt, assignmentStatus
groups/{g}/suggestions/{id}    + sharedId
groups/{g}/assignments/{sid}   NEW  {createdBy, createdByName, text, participants[], createdAt, declined{uid:ts}}
groups/{g}/history/{id}        + folderId, sharedId   (optional, later)
```

## 7. Rules changes (published first)

1. Group doc: owner/admin-only branches for `folders`, and for `roles`+`memberRoles`.
2. Group task create: second branch for owner/admin creating for a member, requiring `assignedBy == auth.uid`; first branch forbids spoofing `assignedBy`.
3. Group task update: owner branch must pin `assignedBy`, `assignedByName`, `assignedAt`, `sharedId`, `sharedBy` to their current values, so a recipient cannot erase or forge who assigned a task.
4. `assignments` subcollection: read = members; create = member creating their own bundle; update = self key in `declined` only; delete = creator or group owner.
5. Solo task and user doc: allow `folders` (size cap) and `folderId` (string, length cap).
6. All new strings get the same name/text length caps used elsewhere (80 / 240 / 2000).

**Things to verify against the Firestore docs before relying on them** (I have not confirmed these):
- Per-request limits on `get()` / `exists()` calls in rules, and whether repeated `get()` of the same group doc counts once, since a 50-member batch evaluates the create rule 50 times. If it does not dedupe, split large fan-outs into several batches.
- Whether a rule can compare `diff().affectedKeys()` on a nested map the way the existing `memberJoinedAt` branch does. (It already does in this repo, so this is the template.)

**Test the rules** before publishing. Option: Firebase Emulator + `@firebase/rules-unit-testing` with a table of allow/deny cases (new dev dependency, see Q6).

---

## 8. What could go wrong, and recovery

| # | Risk | Likelihood | Impact | Prevention | Recovery |
|---|------|-----------|--------|-----------|----------|
| R1 | New rules not published, so client writes fail with permission-denied | High (it has happened here) | Features appear broken | Rules go first; client shows the existing clear `describeGroupWriteError` message; ship checklist (section 10) | Publish rules. No data was written, so nothing to repair |
| R2 | Rules bug lets someone assign tasks, edit roles or forge `assignedBy` | Medium | **Security** | Rules tests (allow/deny table); run `securitymaxxing:authz` and `:diff` skills on the rules diff before publish; pin the `assigned*` fields | Revert `firestore.rules` to the previous version in the Firebase console (keep previous copy in git, tag before publish). Tasks created while the bad rule was live: find by `assignedBy` and review |
| R3 | Rules too strict, so legit assigns/edits are denied | Medium | Annoying, no data loss | Test the owner/admin/member/non-member/kicked-member matrix | Loosen via a rules revision; client already surfaces the error |
| R4 | Partial fan-out (assign to 10, 6 written) | Low | Confusing, unfair | One atomic `writeBatch`. If a batch must split (>500), write the bundle doc **first** and mark it `complete:false` until the last batch lands | On failure show "Assign failed, nothing was sent" and let the user retry. If split-batch half-failed, bundle shows incomplete, and a retry skips uids already present for that `sharedId` |
| R5 | Double-click or retry creates duplicate assignments | Medium | Duplicate cards | Deterministic task ids `${sharedId}_${uid}` so a retry overwrites the same doc; disable Add while pending | Dedupe by `sharedId+owner` in render; admin can delete the extras |
| R6 | Folder deleted, tasks reference a missing folder | Certain (by design) | None | Render unknown `folderId` as Unfiled | Re-create folder with the same name. Users can re-file tasks |
| R7 | Role deleted or member leaves with a role | Certain | None | Role derived at render time, never stored on tasks | None needed |
| R8 | Parser misreads text ("friday" in a title, a word that happens to match a folder name) | Medium | Wrong due date/folder | Only dates are auto-applied; folder/assignee/priority are *suggestion chips* the user taps, never silent; live preview before Add; Undo toast after add | Edit the task. Add a "smart suggestions off" toggle in Settings if complaints appear |
| R9 | Slash menu hijacks typing a literal `/` (e.g. "and/or") | Medium | Annoyance | Menu opens only at start of input or after a space; Esc closes and keeps the `/` as text | n/a |
| R10 | Keyboard shortcut conflicts with typing or browser/screen-reader keys | Medium | Accessibility issue | `N` only when focus is not in an input; Ctrl/Cmd+K suppressed in editable fields that already use it; shortcuts can be turned off in Settings | Remove or rebind the shortcut |
| R11 | Assignee is surprised by dropped-in work, and the assigner gets silent declines | Medium | Social friction | Badge, Decline path, and a visible outcome notification to the assigner (5.4) | Assigner re-assigns or talks to the person |
| R12 | Abuse: an admin spams a member with assignments | Low | Harassment | Per-assign cap of 50 (group size) and a per-minute client throttle; a member-visible "Assigned by" history; rules cap batch size indirectly | Owner can demote the admin (existing flow). Member can decline all |
| R13 | Stale shared card: copies disagree after edits | Medium | Confusing | v1: show original title; per-copy edits are independent and labeled | Optional v1.1 creator-sync rule (Q3) |
| R14 | Performance: Everyone view collapsing 300+ task docs, plus 300 suggestions listener | Low-medium | Jank | Collapse is O(n) over already-loaded docs; folder/role grouping computed once per snapshot | Add pagination later. No new listeners added by this plan |
| R15 | Dusty hallucinates a folder, role or member | Medium | Wrong placement | Validate against real lists; drop unknown; user confirms in review card | Task lands in Unfiled |
| R16 | Merge conflicts: working tree already has uncommitted edits to `script.js`, `group/group.js`, `task-shared.js`, `style.css`, `firebase-init.js`, `brain-dump.js`, `worker/brain-dump-worker.js` and others | **High (right now)** | Lost work | Commit or stash the current changes **before** starting; do each phase on its own branch | `git reflog` / per-phase branches make every phase revertable |
| R17 | Big file edits (`group.js` is ~9,400 lines, `script.js` ~5,500) introduce regressions | Medium | Breakage | Small, per-phase commits; manual regression checklist (section 10); extract new code into new files (`quickadd.js`, `folders.js`, `roles.js`) rather than growing the monoliths | `git revert` the phase commit; fields are optional so old data is unaffected |
| R18 | Account deletion leaves new data behind (`settings.js` deletes user data explicitly; recent commits already fixed "account-deletion gaps") | Medium | Privacy | Add `assignments`, `folders`, `sharedId` docs to the deletion routine as part of each phase | Manual cleanup script; document in privacy page if retained |
| R19 | Time-boxed timezones: assigned `dueAt` for a member in a different timezone | Low | Wrong due time | `dueAt` is stored as ISO UTC already; display in the viewer's timezone (availability work already did the timezone plumbing) | n/a |
| R20 | Cost/limit: Firestore write amplification (50 copies per shared task) | Low | Minor $ | Cap members at 50 (existing); recurrence is per copy (same cost as today) | Throttle or collapse to a single doc in a future v2 |

### Rollback strategy (general)
1. **Tag** the repo and **copy the current `firestore.rules`** into git before every phase (`pre-phaseN`).
2. Each phase is its own branch and merge. To roll back: revert the merge, republish the previous rules.
3. Because every field is optional and old code ignores unknown fields, reverting the client never corrupts data. Reverting rules can only make *new* writes fail, never old reads.
4. Take a **Firestore export** (Firebase console or `gcloud firestore export`) before Phase 4 (the first phase that writes tasks on behalf of others) as a safety net. **[I haven't checked whether your project has billing enabled for exports, so confirm.]**
5. A **feature flag** per phase (a boolean in `firebase-init.js` config or a `featureFlags` map on the group doc) lets us hide a feature instantly without redeploying rules.

---

## 9. Phased plan

Each phase is independently shippable and ends with the regression checklist in section 10.

**Phase 0: Prep (half day)**
- Commit/stash the current uncommitted changes (R16). Tag `pre-organization`.
- Decide open questions (section 12).
- Add rules tests scaffold if Q6 = yes.
- Create new file stubs: `folders.js`, `quickadd.js` (parser moved out of `task-shared.js` with the same exports), `roles.js` (group).

**Phase 1: Personal folders** (solo, lowest risk)
- Data + rules for `users/{uid}.folders` and `folderId`.
- Folder chip row, create/rename/recolor/delete, folder picker in the add form and task editor.
- Filter composes with existing sorting.
- Account deletion untouched (stored on the user doc already deleted).

**Phase 2: Quick-add tokens, `/` menu, shortcuts** (solo first)
- Extend the parser: recurrence words, plus the word-matching that powers suggestion chips (folder, priority words).
- Chips UI, live preview line, `/` menu, `N` and Ctrl/Cmd+K, visible `/` and `+` buttons for touch.
- Unit-test the parser with a table of inputs → outputs (extend the `availability-timezone.test.html` approach: a plain HTML test page, no new tooling).

**Phase 3: Group folders + roles** (group, no assignment yet)
- Rules for `folders`, `roles`, `memberRoles`.
- Settings overlay sections, Team tab role tags, Everyone **Group by Person | Role | Folder**.
- Group quick-add gets the Folder chip and suggestion.

**Phase 4: Direct assign by owner/admin** (highest security risk)
- Rules branch for create-on-behalf and pinned `assigned*` fields.
- "Assign to" for a single person, "Assigned by" badge, Decline, outcome notification.
- `/Assign to` chip and **Assign to Sam?** suggestion.
- Firestore export first (rollback item 4). Run `securitymaxxing:authz` on the rules diff.

**Phase 5: Multi-assign and shared cards**
- `assignments` collection + rules, `sharedId`, deterministic ids, single atomic batch.
- "Assign to: pick people | role | everyone"; member version creates linked suggestions.
- Everyone-view collapse into one card with per-person status; grouped suggestion outcome row.
- `/Share with` chip (people, role, everyone).

**Phase 6: Dusty awareness**
- Worker prompt + client resolution of folder/role/member names; owner/admin-only assignment drafts.

**Phase 7: Tutorials**
- The tour system is `createTourController` in `task-shared.js:972`, with step lists in each page. Add or revise steps for: folders, quick-add suggestion chips and `/` menu, shortcuts, roles, assign/decline, shared cards. Retire any step that points at moved UI.
- Bump the tour storage key so existing users see the new steps once (an existing pattern; confirm the key name in `script.js`/`group.js` before editing).
- Add a "What's new" one-time banner linking to the tour.
- Update `privacy.html` / `terms.html` only if data collection changes (folders and roles are user-authored content, so likely a one-line mention).

**Phase 8: Hardening**
- Full `securitymaxxing:audit` or `:ship-check` pass, accessibility pass on the slash menu and cards, mobile pass, performance pass with a 300-task group.

---

## 10. Testing and release checklists

**Per-phase regression (manual, 15 min)**: add task (form), add task (Dusty), complete/uncomplete, subtasks, recurrence, snooze, handoff, suggestion accept/dismiss, comments, leave/kick/rejoin, delete account, availability tab.

**Rules matrix** (each new rule, allow vs deny): owner, admin, plain member, non-member, kicked member, the target of an assignment, and an unrelated member. Include the forge tests: member sets `assignedBy`, recipient clears `assignedBy`, admin writes to a non-member's task, member edits `roles`.

**Parser table tests**: dates only, repeat words, a word matching a folder, a word matching two folders (no suggestion), priority words, a title that is only a date, unicode names, and very long input.

**Release order**: (1) tag + copy rules, (2) publish rules, (3) smoke-test with two accounts, (4) deploy client behind flag, (5) enable flag, (6) watch for permission-denied reports.

---

## 11. Out of scope (for now)
- Multiple labels/tags per task (folders only, per decision).
- Roles that grant permissions (explicitly rejected).
- Auto-adding future members to existing shared tasks.
- Creator-sync editing of all copies (candidate for v1.1, Q3).
- "Any one of us" completion mode (Q5).
- Folder sharing between solo and group accounts.

## 12. Open questions (my defaults are used if you don't object)

| # | Question | Default |
|---|----------|---------|
| Q1 | One role per member, or several? | One in v1, upgradeable later because `memberRoles` could become `{uid:[ids]}` |
| Q2 | Should Decline expire? | **RESOLVED (owner, 2026-10-30): 15 minutes.** After that the person can still delete the task, and the assigner is told either way. |
| Q3 | Can the creator edit title/due date on everyone's copy? | No in v1; independent copies |
| Q4 | Should people who join later get existing shared tasks? | No |
| Q5 | Need an "any one of us" mode where one completion finishes it for all? | Not in v1 |
| Q6 | OK to add Firebase Emulator + a rules test dev dependency? | Yes, dev-only, never shipped to users |
| Q7 | Folder colors: free picker or a fixed palette of ~10? | Fixed palette (consistent with your design tokens, fewer contrast problems) |
| Q8 | Should folders be visible to Dusty by default? | Yes, names only |
