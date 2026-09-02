# UI/UX Fix Plan

Built from two inputs: the `ui-ux-design` skill (`.claude/skills/ui-ux-design/`, the 19 Laws of UX plus visual design fundamentals) applied against the actual current UI, and real feedback ("it's a bit unclear, had to really look around," compared unfavorably to ChatGPT's simplicity, praise for the deadline-vs-schedule tour copy and the "clicky and cool" feel). Every fix below cites the specific law or craft principle driving it, not general taste. This is a plan to review and prioritize, not a queue to execute top to bottom.

## How this is organized

Each surface (Solo Dashboard, Group Dashboard, Settings, Dusty Chat, Onboarding) gets its own section. Within each, fixes are tagged `[Law]` for a Law of UX or `[Craft]` for a visual-design-fundamentals item, with a severity: **High** (a real driver of the reported confusion), **Medium** (a real but smaller friction point), **Low** (polish, worth doing but not urgent). A cross-cutting section at the end covers issues that repeat across every surface rather than belonging to one.

---

## Priority 0: Directly explains the reported friction

These five are restated from the earlier audit, now grounded in the specific mechanism, since knowing why determines the right fix.

### 0.1 Dusty has no persistent label. `[Law: Jakob's Law + Aesthetic-Usability Effect]` High.
A floating icon with no text, whose only explanation self-dismisses after 6 seconds, breaks the expectation every other nav element in the app sets (every other icon button, settings gear, help "?", sits next to or has an immediate tooltip). Jakob's Law says people transfer patterns from elsewhere; here the pattern the app itself establishes (icon plus label, or icon plus easy discovery) gets broken by its one most-novel feature.
**Fix:** Give Dusty a small persistent label under or beside the icon (doesn't need to be the old full-width pill). Keep the one-time speech bubble as a bonus first impression, not the only explanation.

### 0.2 Tour explains deadline-vs-schedule well, matrix/difficulty not at all. `[Law: Hick's Law + Miller's Law]` High.
The one part of onboarding that got positive feedback is a two-sentence, concrete, contrasting explanation. The matrix/difficulty step is one generic sentence ("set matrix, difficulty, estimate, and deadline") covering 4 concepts at once, a textbook Hick's Law violation (one step, too many new concepts to sort through), and it never actually explains what the matrix's four categories mean.
**Fix:** Split the single "Prioritize" tour step into two: one for matrix (with the same contrast-pair phrasing style that worked for deadline/schedule, e.g. "Important & Urgent gets done now; Important alone gets scheduled") and one for difficulty/estimate.

### 0.3 Icon-only buttons have no touch-device fallback. `[Law: Fitts' Law]` + `[Craft: Icons & Buttons]` High.
Edit, delete, snooze rely entirely on a hover tooltip. Fitts' Law is about reaching a target and knowing it's the right one to reach; on a phone, there's no hover state at all, so an icon-only control is either self-evident or a guess, full stop.
**Fix:** Add a visible text label (not just `title=`) to snooze specifically (the least universally-recognized icon of the three) at minimum; consider labels for edit/delete too on narrow viewports.

### 0.4 Domain vocabulary assumed, not taught. `[Law: Jakob's Law]` Medium.
"Matrix," "auto-sort," "estimate" vs. "scheduled" vs. "due" are all meaningful within a productivity-systems vocabulary a new user doesn't have yet. ChatGPT's contrast point is exactly Jakob's Law: it borrows zero unfamiliar vocabulary before first use.
**Fix:** Not a rename of the whole system, just a plain-language subtitle under the more jargon-heavy labels (e.g. "Task Matrix" gets a one-line "how urgent + how important" under it, visible without opening a tooltip).

### 0.5 Almost nothing is progressively disclosed. `[Law: Hick's Law + Tesler's Law]` + `[Craft: Visual Hierarchy]` High.
The Prioritize panel is the one place in the whole app that's collapsed by default. Everything else, full side column, both filter rows, the leaderboard, the activity heatmap, renders in full on first load, all competing for attention with equal visual weight (no hierarchy contrast between "do this now" and "explore later"). Tesler's Law: this complexity has to live somewhere; right now it's all pushed onto the user's eyes at once instead of absorbed by progressive disclosure.
**Fix:** Extend the collapsed-by-default pattern to secondary panels (see per-surface sections below for exactly which ones).

---

## Navigation restructuring: splitting the single page into views

The biggest lever in this whole plan, bigger than any individual fix above, and a direct answer to "too many things on one page." Right now, both `index.html` and `group/index.html` render everything at once: task input, filters, task list, activity heatmap, and every side panel, all in one continuous page. Section-by-section collapsing (0.5 above) helps, but real navigation is the more durable fix, and applies Hick's Law and Tesler's Law at the whole-page level rather than one panel at a time.

**Proposed split, for review before building:**

Solo:
- **Tasks** (default view). Task input, filters, task list. What most visits are actually for.
- **Activity** (separate view). Heatmap and streak stats. Currently permanent side-column real estate for something checked occasionally, not every visit.
- Priority controls (auto-sort, popup alerts, difficulty-visibility toggle) fold into Settings, where they already conceptually belong, instead of a third floating side-column block.

Group adds:
- **Team** (separate view). Member roster, leaderboard, suggestions-for-you. Currently the single biggest density jump in the whole app (2.3 above).
- Recently Finished stays as its own overlay, already effectively separate.

**Shape of the navigation itself:** a lightweight tab bar (2 to 3 tabs), reusing the app's existing pill/tab visual language already established for task-view filters, rather than introducing a brand-new nav pattern. Jakob's Law again: reuse what the app already taught the user, don't add a second nav convention on top of the first. A same-page tab-switch (show/hide sections via JS, the same mechanism the task-view filters already use) fits the app's existing architecture far better than real page routing would, and avoids a much bigger rebuild for the same result.

This touches page structure on both dashboards and is worth its own dedicated planning pass before any code changes, given the scale.

---

## 1. Solo Dashboard

### 1.1 Task input row and Prioritize panel
- **`[Law: Hick's Law]` High.** Once expanded, the Prioritize panel presents 5 independent decisions at once (matrix, difficulty, estimate toggle plus chips, deadline, schedule) with zero sequencing. Consider a two-tier disclosure: matrix plus difficulty visible on first expand (the two that actually drive sort order), deadline/schedule/estimate behind a second "more options" reveal for tasks that need them (most quick-added tasks probably don't set a schedule).
- **`[Law: Von Restorff Effect]` Medium.** The `+` add button and the `Prioritize` button currently read as similarly weighted (both are button-shaped, similarly sized). Only one is the primary action for a fast task-add flow. Give `+` clearer primary styling (fill/color) and `Prioritize` a visibly secondary treatment (ghost/outline) so the eye lands on the right one first.
- **`[Craft: Feedback & States]` Medium.** Confirm the `+` button has a distinct disabled state when the input is empty, not just a no-op click; right now an empty submit likely just silently does nothing, which reads as broken rather than "not ready yet."

### 1.2 Task rows
- **`[Craft: Signifiers]` Medium.** Up to 5 badges (matrix, difficulty, deadline, schedule, effort) can appear on one row simultaneously with no visual grouping between them, Law of Common Region isn't applied here even though it's the exact situation it's for. Consider a subtle shared background/rail behind the badge cluster so it reads as "task metadata" as one unit, separate from the task text itself.
- **`[Law: Serial Position Effect]` Low.** Badge order (matrix, difficulty, deadline, schedule, effort): confirm the most decision-relevant one (deadline, when present) is first or last, not buried third, since that's what recency/primacy actually favors for quick scanning.
- **`[Craft: Icons & Buttons]` High.** Edit, snooze, delete are three visually similar icon-only buttons in a row with no differentiation by weight or color. Delete is a destructive action sitting at the same visual weight as edit. Jakob's Law convention: destructive actions are typically differentiated (red tint, more spacing from the others, or a confirm step already present, if a confirm step exists that's good, but the button itself should still look different at rest).
- **`[Craft: Grids & spacing]` Low.** Subtasks toggle ("2/5") sits inline with the other row actions; confirm it has enough separation (proximity) from the edit/snooze/delete cluster so it doesn't read as a 4th action of the same kind.

### 1.3 Side column
- **`[Law: Hick's Law]` High.** Activity heatmap, priority controls, auto-sort, popup alerts, difficulty-visibility toggle all render at once, permanently, next to the main list. None of this is needed to add or complete a first task. Candidate for a collapsed-by-default "Settings & stats" disclosure, matching the fix pattern in 0.5.
- **`[Craft: Typography]` Low.** Confirm the side column doesn't introduce a second distinct type scale from the main column; worth a direct check since side panels are a common place for scale drift to creep in unnoticed.

### 1.4 Task views / filters
- **`[Law: Miller's Law]` Low.** 6 tabs (All/Focus Now/Overdue/Today/Week/Completed) is right at the edge of comfortable working memory but not over it, no fix needed, flagged only so a future addition doesn't push it past 7.
- **`[Craft: Color]` Medium.** Confirm the Overdue count badge uses a genuinely semantic red/urgent color distinct from any other badge color already in use elsewhere (matrix badges, difficulty badges); semantic color only works if it's not also reused decoratively nearby.

---

## 2. Group Dashboard

Everything in section 1 applies here too (same task input, same row anatomy, same filters); this section only covers what's genuinely additional.

### 2.1 Header actions
- **`[Law: Hick's Law]` Medium.** 4 buttons in the header action row (alerts, settings, leave, delete). Leave and Delete are both destructive/rare actions sitting at equal visual weight to Settings and Alerts, which are used far more often. Consider moving Leave/Delete into the Group Settings overlay itself (they're already role-gated concepts that live conceptually with the rest of group management) rather than as permanent top-level buttons.
- **`[Craft: Visual Hierarchy]` Low.** Invite code plus copy button sits in its own row above the action buttons; confirm it's visually secondary to the action row, since it's read-only info, not a frequent action.

### 2.2 Double filter rows
- **`[Law: Law of Similarity]` High.** "Whose tasks" (member scope) and "Filter by deadline" are two visually near-identical tab rows stacked directly on top of each other. Similarity says visually-alike elements get read as the same type of thing, but these are two independent, combinable filter axes, not one sequence. Right now nothing distinguishes them as separate systems beyond the text label above each. Consider differentiating them structurally (e.g., member-scope as avatar chips instead of text tabs) so they read as two different kinds of control, not one longer list of tabs.

### 2.3 Side column
- **`[Law: Hick's Law]` High.** Suggestions-for-you, member roster, leaderboard, recently-finished all render permanently, in addition to solo's already-present activity/priority controls being absent here but replaced with an equal amount of new content. This is the single biggest density jump in the whole app (the earlier audit's "~34 additional controls" finding). Leaderboard and recently-finished are both genuinely secondary/exploratory, strong candidates for collapse-by-default, keeping only the roster and any pending suggestions visible immediately (the roster is core "who's doing what," suggestions need a response).
- **`[Craft: Feedback & States]` Medium.** Member roster cards carry a "suggest a task" button and (for admins) a "kick" button on the same card; confirm kick has a visually distinct, more cautious treatment (Jakob's Law: destructive team actions are conventionally harder to trigger by accident than a suggestion).

### 2.4 Overlays
- **`[Law: Miller's Law]` Medium.** The Group Settings overlay bundles three distinct concepts (privacy select, role/admin list, pending join requests) into one modal. Each is independently a small decision; together in one panel it's a lot to parse in one place. Consider tabs or clearly separated sections within the modal, at minimum a stronger visual break (Law of Common Region) between the three.

---

## 3. Settings

This is, by the audit's own count, one of the clearer surfaces already: plain-English section headers, one thing per section, nothing competing for attention. Mostly craft-level polish here, not structural.

- **`[Craft: Feedback & States]` Medium.** Confirm every action (Save name, Export, Add memory, Delete account) gives a visible success/failure response, not just a disabled-button-during-request state. A save that silently succeeds with no confirmation text risks feeling like it didn't work (this is Zeigarnik-adjacent: an unclosed loop reads as unfinished even if it technically succeeded).
- **`[Law: Serial Position Effect]` Low.** Confirm "Delete account" being last in the section order is deliberate (it should be, burying the highest-stakes, least-frequent action at the end, away from primacy, is the right call here) rather than incidental.

---

## 4. Dusty Chat

- **`[Law: Miller's Law]` Medium.** Four distinct review-card types (task/suggestion/comment/memory) can theoretically all appear in one response. If more than a couple ever land in a single reply, confirm they're visually chunked (grouped headers per type) rather than one long undifferentiated scroll of cards.
- **`[Craft: Signifiers]` Low.** Quick-reply chips and the send button are both "commit an action" affordances that look different from each other by necessity. Confirm a chip doesn't read as if it already sent the message (it fills the input, doesn't send); a brief inline cue ("edit or hit send") the first time one's used would close that ambiguity.
- **`[Law: Doherty Threshold]` Low, already likely fine.** Typing indicator already covers the wait-for-response gap, no action needed, noted only to confirm it stays present as more response types get added.

---

## 5. Onboarding & Tours

- **`[Law: Hick's Law]` See 0.2, the single highest-value fix in this whole document.**
- **`[Law: Zeigarnik Effect]` Low, positive pattern to preserve.** The tour's step counter ("Step 1 of 7") already creates a healthy open-loop pull to finish it; don't remove this in any redesign, it's doing real work.
- **`[Craft: Feedback & States]` Medium.** Confirm Skip vs. Next are visually distinct enough that skipping isn't a mis-tap away from continuing, since skipping is exactly the failure mode the earlier feedback confirmed happens (or at least, going through the whole thing and still being confused after, which points at the same root cause: too much per step, not too few steps).

---

## Cross-cutting (applies everywhere, not one surface)

- **`[Craft: Typography]`, `[Craft: Icons]`, `[Craft: Color]`.** Confirmed with real numbers, not just flagged as worth checking; see Code-level findings below.
- **`[Law: Aesthetic-Usability Effect]` Low, reassuring, not urgent.** The "clicky and cool, felt like a game" feedback is this law in action; the app's existing sound/animation polish is already buying real goodwill. Worth protecting deliberately while making the fixes above, not something to strip out in the name of "simplifying."

---

## Code-level findings

Real numbers pulled directly from `style.css` and the HTML files with grep/PowerShell, not impressions, checked against the skill's craft checklist.

- **`[Craft: Typography]` Confirmed, High.** 18 distinct font-size values in use (8px through 36px, covering nearly every integer from 8 to 18), across 185 total `font-size` declarations. The skill caps landing pages at about 6 sizes total and keeps dashboards even tighter. This isn't a deliberate type scale, it grew organically feature by feature across the session.
- **`[Craft: Grids & spacing]` Confirmed, High.** 240 padding/margin/gap declarations checked; 121 of them (50%) are not a multiple of 4px. No consistent spacing system is actually being followed, despite the skill's explicit 4-point-system guidance.
- **`[Craft: Inconsistent components]` Confirmed, Medium.** 14 distinct border-radius values in use for rounded rectangles alone (999px pills and 50% circles aside, which are legitimately different shapes, not a scale problem). Should realistically be 2 to 3 tiers, not 12-plus near-random values.
- **`[Craft: Color]` Confirmed, Medium to High.** 33 CSS custom properties already exist for the violet palette (`--violet-accent`, `--violet-muted`, and others), a real token system is genuinely in place. But hardcoded violet-family `rgba(...)` literals appear almost exactly as often (154 times) as the actual custom properties get used (151 times). Roughly half the app's own color system bypasses the tokens that already exist, most likely because new components were written with copy-pasted rgba values across the many feature additions this session instead of reusing the established variables.
- **`[Craft: Icons]` Confirmed, Medium.** The Deadline field icon (`fa-regular fa-calendar`, outline style) and the Schedule field icon (`fa-solid fa-clock`, filled style) sit directly next to each other as two parallel, equally-weighted fields, but use two different icon styles with no semantic reason for the difference. Small, easy, high-visibility fix: pick one style and apply it to both.
- **`[Craft: Shadows]` Worth a look, Low to Medium, not clearly wrong.** Most shadows in the app are appropriately subtle (0.14 to 0.35 opacity glows on focus rings and buttons). The handful of full-modal shadows (task editor, settings, auth card) run stronger, 0.45 to 0.56 opacity at large blur radii, which the skill flags as commonly overdone. This may be intentionally tiered since modals should read as more elevated than cards; worth a deliberate check rather than an assumed fix.
- **`[Craft: Feedback & States]` Confirmed as a strength, not a mistake.** 67 `:focus`/`:focus-visible` rules already exist in the stylesheet. Keyboard-accessibility groundwork here is genuinely already better than average. A redesign should preserve this, not regress it.

---

## Suggested order

1. **Navigation restructuring** first. The biggest single lever, and it changes what several fixes below even need to be, since a fix like "collapse the side column" becomes "move it to its own view" once real navigation exists.
2. **0.1 to 0.5** next. Direct line to actual reported confusion, mostly independent of the navigation work so they can happen in parallel.
3. **2.2** (differentiate the two group filter rows). Biggest remaining group-specific fix once Team has its own view.
4. **Code-level findings**: font-size scale, spacing system, border-radius tiers, color-token adoption, the deadline/schedule icon mismatch. Best done as one focused pass once the structural changes above are settled, since moving things into new views will touch a lot of this CSS anyway.
5. Everything tagged Low. Polish once the above is done, not before.
