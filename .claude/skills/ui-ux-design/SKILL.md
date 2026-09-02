---
name: ui-ux-design
description: >
  Reference and active application of UI/UX design knowledge: the 19 Laws of UX
  (Aesthetic Usability Effect, Doherty Threshold, Fitts' Law, Hick's Law, Jakob's Law,
  the four Gestalt grouping laws, Miller's Law, Occam's Razor, Pareto Principle,
  Parkinson's Law, Postel's Law, Serial Position Effect, Tesler's Law, Von Restorff
  Effect, Zeigarnik Effect) plus practical visual design craft (signifiers, hierarchy,
  spacing, typography, color, dark mode, shadows, icons, states, micro-interactions,
  overlays) and common beginner mistakes. Use whenever Abir asks about UX/UI principles
  or design theory, even casually, like "why does this feel cluttered" or "how do I make
  this look more professional." Also use whenever building, designing, or reviewing any
  user-facing interface (artifacts, mockups, landing pages, app screens, game UI,
  wireframes, forms), running a design critique before calling it done, even unprompted.
  Applies to game dev (itch.io), startup products, and any HTML/React UI built here.
---

# UI/UX Design

This skill has two jobs: be a reference source for UX psychology and visual design craft, and actively critique any interface this instance builds or reviews, using that knowledge as the lens.

## Why this exists

This skill covers two related but distinct bodies of knowledge. `references/laws-of-ux.md` covers the 19 Laws of UX: real research from psychology, human-computer interaction, and business explaining how people perceive, remember, decide, and physically interact with interfaces. `references/visual-design-fundamentals.md` covers the hands-on craft of actually building a screen: hierarchy, spacing, type, color, and the specific mistakes that make a UI read as amateur versus polished. Together they cover both why an interface works and how to actually build one that does. Treat both as a working toolkit, not decoration: when building something a person will look at or click on, checking it against this knowledge catches real problems before a real user hits them.

## Mode 1: Reference

When Abir asks about a UX/UI concept, explain it in plain terms and pull from the relevant reference file rather than reconstructing it from memory:
- Psychology-flavored questions ("why do people remember X," "what's the research behind Y") → `references/laws-of-ux.md`
- Craft/execution questions ("how should I space this," "what's wrong with my color choices," "how do I fix this shadow") → `references/visual-design-fundamentals.md`
- Some questions touch both (e.g. why a standout button works is both Von Restorff Effect and a hierarchy/contrast question) — pull from whichever framing actually answers what was asked, or both if genuinely useful.

Only pull in the specific laws or sections relevant to the question, not the full reference every time.

## Mode 2: Active critique

Whenever this instance builds a UI artifact (HTML, React, mockup, wireframe) or is asked to review one Abir describes, pastes, or screenshots, run a lightweight pass against the quick reference tables below before presenting the result as finished. Not everything applies to every screen. Pick what's actually relevant given what's being built, and skip the rest rather than forcing the full checklist into every critique.

**How to fold this in without becoming a checklist-reciting bot:**
- While designing, actively apply this knowledge as you go (correct button sizing per Fitts' Law, real hierarchy through size/color contrast, consistent spacing and icon style) rather than designing first and patching after.
- After building, do one quick pass and flag anything that's off, with a one-line fix. Keep this concise. A short "design notes" section after the artifact is enough. Don't write a full audit for a simple button.
- If asked to explicitly critique an existing design (a screenshot, a competitor's app, Abir's own game UI), go deeper: name each issue specifically, whether it's a law violation or a craft mistake, why it matters, and a concrete fix. Use both reference files for the reasoning.
- If a design choice deliberately breaks a convention for a good reason, say so rather than flagging it as an error. This is a toolkit of heuristics, not hard rules.

## Quick Reference: Laws of UX (psychology)

| Law | One-line rule | Reaches for it when... |
|---|---|---|
| Aesthetic Usability Effect | Attractive design gets rated as more usable, even when function is identical | Polishing visuals matters more than it feels like it should, especially early |
| Doherty Threshold | System response under 400ms keeps users engaged; above it, they disengage | Any interaction involving loading, feedback, or animation timing |
| Fitts' Law | Time to hit a target depends on its size and distance; bigger and closer is faster | Sizing and placing buttons, especially primary actions and mobile targets |
| Hick's Law | More choices = slower decisions; break big decisions into smaller steps | Menus, navigation, onboarding flows, forms with many fields or options |
| Jakob's Law | Users expect your interface to work like the ones they already know | Navigation patterns, icon choices, any place convention already exists |
| Law of Common Region | Elements sharing a bounded area (box, card) are seen as one group | Card layouts, form sections, grouping related settings |
| Law of Prägnanz | Ambiguous visuals get read the simplest way possible | Icon design, logo design, anything that could be visually misread |
| Law of Proximity | Elements placed close together are seen as related | Spacing between related vs. unrelated content |
| Law of Similarity | Visually similar elements are seen as the same type of thing | Consistent styling for all links, all buttons, all tags of the same type |
| Law of Uniform Connectedness | Elements joined by a visible connector (line, shared color) read as more related than proximity alone | Diagrams, flow indicators, linking distant but related elements |
| Miller's Law | Working memory holds about 7 (±2) items; chunk content accordingly | Navigation menus, lists, any content longer than ~7 items |
| Occam's Razor | Between equally effective options, pick the one with fewer assumptions | Choosing between two features or flows that solve the same problem |
| Pareto Principle | ~80% of value comes from ~20% of causes; focus effort there | Prioritizing which features/screens deserve the most design effort |
| Parkinson's Law | Tasks expand to fill the time given them | Not a visual law, but relevant to scoping design/dev time realistically |
| Postel's Law | Accept messy input, return clean output | Form validation, input parsing, error handling |
| Serial Position Effect | First and last items in a sequence are remembered best | Ordering list items, nav items, or content in a sequence |
| Tesler's Law | Complexity can't be removed, only moved between system and user | Deciding what to automate/absorb vs. what to expose to the user |
| Von Restorff Effect | The item that visually breaks the pattern gets remembered | Making one primary CTA stand out from secondary actions |
| Zeigarnik Effect | Unfinished tasks are remembered better than finished ones | Progress bars, onboarding completion states, retention hooks |

Full depth (mechanism, origin study, examples): `references/laws-of-ux.md`

## Quick Reference: Visual Design Craft

| Topic | Core rule |
|---|---|
| Signifiers | Every interactive/stateful element needs a visible signal for what it does or what state it's in |
| Hierarchy | Size + position + color contrast (not any single layout) creates hierarchy; most important = top, big, colorful |
| Grids & spacing | Grids are guidelines, most useful for repeating content; white space matters more than grid precision; use a 4pt spacing system |
| Typography | One font is almost always enough; ~6 sizes max for landing pages, tighter range (rarely past 24px) for dashboards |
| Color | Start from one primary color, derive tints/shades; use color semantically (blue=trust, red=danger, yellow=warning, green=success), not decoratively |
| Dark mode | Not just inverted light mode: lower border contrast, use lighter cards (not shadows) for depth, dim saturated colors |
| Shadows | Default presets are usually too strong; reduce opacity, increase blur, match strength to elevation |
| Icons & buttons | Size icons to match adjacent line-height; ghost buttons for secondary actions; button padding ≈ 2x height for width |
| Feedback & states | Every action needs a response; every button/input needs default/hover/active/disabled (+ error/focus/loading where relevant) |
| Micro-interactions | Confirm the result of an action happened, not just that it was clicked |
| Overlays | Use gradients (not flat overlays) to keep an image visible while keeping text readable |

Common beginner mistakes (user flow gaps, overusing effects, poor spacing, inconsistent components, icon problems, redundant elements, missing feedback, overdesigned charts) plus a full active-critique checklist: `references/visual-design-fundamentals.md`

## Full references

- `references/laws-of-ux.md` — full depth on all 19 psychological laws: mechanism/explanation, origin/source study, additional examples.
- `references/visual-design-fundamentals.md` — full depth on visual craft fundamentals and the 8 most common beginner mistakes, each with what goes wrong and the fix, plus a ready-to-use critique checklist.

Read whichever file is relevant when doing a deep critique, answering a detailed question, or when the quick-reference tables above aren't enough to give a real answer.
