# Visual Design Fundamentals & Common Mistakes — Full Reference

Practical UI craft knowledge, separate from the psychological Laws of UX in `laws-of-ux.md`. This file covers the hands-on decisions that go into actually building a screen: signifiers, hierarchy, spacing, type, color, dark mode, shadows, icons, states, micro-interactions, overlays, and the mistakes that make a UI read as amateur. Use this alongside `laws-of-ux.md` during active critique. The two overlap in places (e.g. Von Restorff Effect and visual hierarchy are describing the same underlying mechanism from different angles) — that's expected, use whichever framing is more useful in the moment.

---

## Part 1: Core Fundamentals

### Signifiers
**Rule:** Good UI shows how it works without needing instructions. A container around related items signals grouping, a filled/highlighted state signals selection, grayed-out text signals inactive.
**Apply it:** Every interactive or stateful element needs a visual signal for what it affords: button press states, active nav highlights, hover states, tooltips. If a user has to guess whether something is clickable or what state it's in, add a signifier.

### Visual Hierarchy
**Rule:** Size, position, and color create hierarchy through contrast, not through any single "correct" layout.
**Apply it:**
- Most important content goes near the top, larger, and bolder.
- Contrast is what creates hierarchy: the gap between big/small or colorful/neutral is what draws the eye, not the size or color in isolation.
- Images add a strong pop of color and make scanning faster; use them near the top when available.
- There's no single correct arrangement; multiple hierarchies can be equally valid as long as they follow the same underlying rules (important = top, big, colorful; secondary = smaller, muted, below).
- Use icons and connecting lines to imply relationships (e.g. an origin-to-destination flow) instead of spelling them out in text.

### Grids, Layouts & Spacing
**Rule:** Grids are guidelines, not laws. A design doesn't have to snap to a strict 12-column grid to be correct, but consistent structure matters more for repeating content (galleries, blogs, feeds) than for one-off custom layouts (landing pages).
**Apply it:**
- Use grid systems (12-column desktop, 8-column tablet, 4-column mobile) mainly for responsive behavior on structured, repeating content.
- White space matters more than grid precision. Let content breathe.
- Group related elements with tighter spacing (this is Law of Proximity from the laws reference, applied practically).
- Use a 4-point spacing system (all spacing values are multiples of 4) for consistency, not because multiples of 4 inherently look better, but because they can always be split in half cleanly.

### Typography
**Rule:** One font is almost always enough. Hierarchy comes from size and weight variation within that one font, not from mixing fonts.
**Apply it:**
- Use one sans-serif font for the vast majority of designs.
- Tightening letter spacing (roughly -2% to -3%) and reducing line height (110-120%) on large header text makes it read as more polished.
- Landing pages/websites: aim for no more than about six font sizes total, with a wide range between the largest and smallest.
- Dashboards and information-dense UIs: keep the font size range much tighter, generally not exceeding ~24px, since density matters more than dramatic size contrast.
- Pull design inspiration from real, shipped products rather than designing from scratch every time.

### Color Theory
**Rule:** Start with one primary (brand) color, then derive lighter tints for backgrounds and darker shades for text. This gets you halfway to a full color ramp (the system large companies use for chips, states, charts, etc).
**Apply it:**
- Use semantic colors with actual meaning: blue for trust, red for danger/urgency, yellow for warning, green for success.
- Color should signal something (an announcement, a focus state, a new/success indicator), not just decorate. If a color doesn't communicate anything, question whether it needs to be there.

### Dark Mode
**Rule:** Dark mode isn't just an inverted light mode. It needs its own contrast and depth logic.
**Apply it:**
- Lower border contrast; a light border on a dark card usually reads as too harsh.
- Since dark mode has no real shadows, create depth by making cards lighter than the background instead.
- Dial down saturation and brightness on colored elements (chips, tags) that were tuned for light mode, and flip contrast for their text.
- Dark mode allows more flexibility for deep purples, reds, and greens, not just the default navy/gray.

### Shadows
**Rule:** Shadows create depth on light mode designs, but default shadow presets (like Figma's) are usually too strong.
**Apply it:**
- Reduce opacity and increase blur radius on default shadows.
- Match shadow strength to elevation: cards need less shadow, content that floats above other content (popovers, modals) needs stronger shadow.
- Inner and outer shadows combined can simulate raised, tactile buttons.
- If the shadow is the first thing a viewer notices, it's overdone. Shadows should support the design, not announce themselves.

### Icons & Buttons
**Rule:** Icon sizing should match the type it sits next to, and buttons follow a few consistent structural patterns.
**Apply it:**
- Size icons to match the line-height of the adjacent font (e.g. 24px icon next to 24px line-height text), and tighten the text spacing next to it.
- "Ghost buttons" (no background until hover) are common for sidebar links and secondary actions, especially paired with a primary CTA.
- A reasonable padding guideline for buttons: roughly double the height for the width.

### Feedback & States
**Rule:** Every user action needs a visible response. Every interactive element needs multiple states.
**Apply it:**
- Buttons need at minimum: default, hover, active/pressed, and disabled states. Add a loading state (spinner) when relevant.
- Inputs need: focus state, error state (often a red border plus a message), and sometimes a warning state for non-blocking issues.
- Apply this everywhere: loading spinners during data fetches, success messages on completed actions, subtle animations on scroll or swipe.

### Micro-interactions
**Rule:** A micro-interaction is feedback taken one step further, confirming an action happened, not just that it was clicked.
**Apply it:** A button having hover/click states isn't enough if the user still can't tell whether the underlying action succeeded (e.g. did the copy-to-clipboard actually work?). A small animated confirmation (a chip sliding up, a checkmark flash) closes that gap. These range from purely functional to playful, depending on the product's tone.

### Overlays
**Rule:** A poorly designed overlay ruins both the content underneath and the text on top of it.
**Apply it:** Avoid flat full-screen overlays that flatten an image without reason. Use a linear gradient that preserves the image while fading into a text-readable background where needed. A progressive blur layered on top of the gradient can push this further for a more polished look.

---

## Part 2: Common Beginner Mistakes

### Mistake 1: Missing user flow planning
**What goes wrong:** Screens get designed in isolation without mapping the full flow, so edge cases get missed: no search/skip option when six presets don't cover every case, no way to opt out, no way to handle "none of the above."
**Fix:** Sketch the flow (even just boxes on paper) before designing screens, specifically to catch missing states: what happens if the user has none of the options, wants to search, or wants to skip. Also check for commonly missed small elements: filter icons on search bars, save buttons, hover states, and micro-interactions that make actions feel responsive.

### Mistake 2: Overusing visual effects
**What goes wrong:** Gradients, glows, and shadows stacked together read as cluttered and amateur, not polished.
**Fix:**
- If using a gradient, stay within variations of a single color (a lighter and darker version of the same hue) rather than combining unrelated colors. Often, no gradient at all is the better call.
- Default shadow presets are usually too harsh. Change the shadow color to a light gray (not just lowering opacity) and increase blur significantly, or remove the shadow entirely.
- General rule: less visual noise usually reads as better design, not more.

### Mistake 3: Poor spacing
**What goes wrong:** Beginner UIs tend to pack elements too tightly.
**Fix:**
- Set up a grid (even a simple 2 or 3 column one) and align elements to it as closely as reasonable. Small intentional grid breaks are fine if they still feel balanced.
- Increase vertical spacing between stacked content to let it breathe, especially on mobile, which generally needs more space than intuition suggests.
- Use auto-layout-style tooling (turning off vertical trim for pixel-level control) to fix inconsistent card/chip spacing, then repeat the same spacing pattern across the UI for consistency.

### Mistake 4: Inconsistent components
**What goes wrong:** The same type of element (e.g. two buttons that do similar things) ends up with different corner radii, sizes, or styles across a design, which reads as unpolished even if each individual instance looks fine.
**Fix:** Standardize: identical search bars (only prompt text differs), a single corner radius value for all small components, matching size/radius/style for equivalent buttons (like back and skip). Use reusable styles for colors, variables for measurements, and components for repeated UI elements, rather than manually re-styling each instance.

### Mistake 5: Icon problems
**What goes wrong:** Missing icons force users to read more text and slow down browsing. Mismatched icon styles (mixed fill vs. line, inconsistent stroke width) read as sloppy.
**Fix:**
- Add icons where they'd reduce reading load (e.g. on cards, replacing text labels like "save").
- Pull icons from a single consistent library/style (matching stroke width and corner treatment) rather than mixing sources.
- Export as SVG for best quality.
- Well-known icons (house, bookmark, user) don't need labels. Less obvious icons benefit from a tooltip.
- It's fine to mix icon styles across a design only if the different styles are used in visually separate areas (e.g. nav icons vs. content-category icons vs. feature icons) so they don't clash directly.

### Mistake 6: Redundant elements
**What goes wrong:** Extra visual elements that don't add function, like arrows implying "swipe" on a screen that's already swipeable on mobile, or unnecessary strokes/borders, just add clutter.
**Fix:** Remove elements that duplicate a function the interface already communicates another way (e.g. mobile swipe gestures don't need an arrow icon reinforcing them). If contrast is a concern instead of full removal, dimming an element down is a middle-ground option.

### Mistake 7: Missing interactive feedback
**What goes wrong:** This is the inverse of Mistake 2. If there's a delay before a screen transition or action completes, and nothing visually changes in that gap, it looks like the click didn't register at all.
**Fix:** Add an immediate visual response on interaction (e.g. a button graying out on click) even before the full result is ready, and add a loading indicator if the wait is longer. For actions with a lasting result (like saving an item), reflect that result in multiple places if relevant (the icon itself, plus a badge/dot on a related nav tab) so the user has clear confirmation.

### Mistake 8 (bonus): Overdesigned charts
**What goes wrong:** Charts that look aesthetically impressive (no axis, rounded bar tops, mismatched bar count vs. data categories) often communicate less information than a plain one, because visual polish got prioritized over legibility.
**Fix:** Keep a visible, labeled axis. Match the number of visual elements (bars, segments) to the actual number of data points, don't add decorative extras. A less aesthetic but clearly readable chart beats a stylish but confusing one every time. This applies directly to any data viz built for content, dashboards, or product metrics.

---

## Quick checklist for active critique

When reviewing or building a screen, scan for:
- [ ] Does every interactive element have a visible signifier (state, hover, highlight)?
- [ ] Is there clear hierarchy (one dominant element, contrast between important/secondary)?
- [ ] Is spacing consistent, and does content have room to breathe?
- [ ] Is only one font used, with a sane number of sizes for the context (dashboard vs. landing page)?
- [ ] Is color used semantically (not just decoratively)?
- [ ] If dark mode: are borders/shadows adjusted, not just inverted from light mode?
- [ ] Do shadows/gradients look intentional and restrained, not stacked and heavy?
- [ ] Are icons consistent in style/stroke, and correctly sized to adjacent text?
- [ ] Does every button/input have the full set of states (default, hover, active, disabled, error/focus where relevant)?
- [ ] Is there feedback for every user action, including ones with a delay?
- [ ] Are there redundant elements that could be cut?
- [ ] If a chart is involved, is it legible over decorative?
