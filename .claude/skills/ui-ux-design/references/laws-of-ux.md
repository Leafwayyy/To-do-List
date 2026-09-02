# Laws of UX — Full Reference

Source: John Yablonsky's "Laws of UX" project. Nineteen principles from psychology, computer science, and business explaining how people perceive and interact with interfaces. Read the relevant section below when a quick one-liner from SKILL.md isn't enough.

---

### Aesthetic Usability Effect
**Rule:** Users perceive aesthetically pleasing design as more usable, even when actual usability hasn't changed.
**Mechanism:** First impressions are emotional and instant, based on appearance. That impression becomes the lens users judge every later interaction through, so a good-looking product gets forgiven for functional flaws an ugly one wouldn't.
**Origin:** 1995, Masaaki Kurosu and Kaori Kashimura, Hitachi Design Center. Tested 26 ATM UI variations; found a stronger correlation between rated attractiveness and perceived ease of use than between attractiveness and actual ease of use.
**Apply it:** Invest in visual polish early, especially in an MVP or early-stage product where functionality isn't fully built out yet. It buys real goodwill.
**Watch for:** This can mask real usability debt. Don't let a good-looking prototype convince you a genuine functional flaw doesn't need fixing.

### Doherty Threshold
**Rule:** Productivity and engagement rise when a system responds to the user in under 400ms.
**Mechanism:** Fast enough feedback keeps the user in flow, uninterrupted. Cross 400ms and the brain registers a wait, breaking focus.
**Origin:** 1982, Walter Doherty and Ahrvind Thadani, IBM Systems Journal. Set 400ms as the new response-time requirement, replacing the prior 2,000ms standard.
**Apply it:** Optimize load times and loading states for anything interactive. If a genuine wait is unavoidable, use a progress indicator or skeleton state to reduce perceived latency.
**Watch for:** This is one of the most concrete, measurable laws here. Actually test response times rather than eyeballing them.

### Fitts' Law
**Rule:** Time to acquire (click/tap) a target is a function of distance to it and its size.
**Mechanism:** Small, far targets require slower, more careful movement or produce more misses (speed-accuracy trade-off).
**Origin:** 1954, psychologist Paul Fitts, studying the human motor system.
**Apply it:** Make primary actions large and easy to reach. On mobile, targets need to be bigger than desktop equivalents since fingers are less precise than a cursor. Keep frequently used controls close to where the user's attention already is.
**Watch for:** Don't oversize everything, or nothing stands out as primary. Size should communicate importance.

### Hick's Law
**Rule:** Decision time increases with the number and complexity of choices.
**Mechanism:** Every extra option adds interpretation and sorting work before a user can act, which is measurable cognitive load, not just annoyance.
**Origin:** 1952, William Edmund Hick and Ray Hyman, studying stimuli count vs. reaction time.
**Apply it:** Reduce visible options at any single decision point. Break complex tasks (checkout, onboarding, multi-field forms) into a sequence of small decisions instead of one big one.
**Watch for:** Don't over-apply this to the point of hiding options a user actually needs — the goal is reducing unnecessary choice, not all choice.

### Jakob's Law
**Rule:** Users spend most of their time on other products, so they expect yours to work the same way.
**Mechanism:** Existing products shape user expectations. Matching those patterns lets users transfer skill instantly; breaking convention adds friction since users have to unlearn a habit first.
**Origin:** Jakob Nielsen, Nielsen Norman Group, co-founded with Don Norman (ex-Apple). Established the "discount usability engineering" movement.
**Apply it:** Default to established conventions (cart icon top-right, hamburger menu, standard back-button behavior) unless there's a strong specific reason to break them.
**Watch for:** This is more industry heuristic than controlled study. It's a strong default, not an absolute rule — genuine innovation sometimes requires breaking convention deliberately.

### Law of Common Region
**Rule:** Elements sharing a clearly bounded area (border, background, shadow) are perceived as a group.
**Mechanism:** One of five Gestalt grouping principles (proximity, similarity, continuity, closure, connectedness). A visible boundary is a stronger grouping signal than proximity or color alone, since it draws a literal line the brain doesn't need to infer.
**Origin:** Gestalt psychology, explaining humans' innate tendency to organize visual input into patterns (Prägnanz).
**Apply it:** Card layouts, form sections, grouped settings. Use a visible container when you want related elements read as one unit without relying on subtler cues.

### Law of Prägnanz
**Rule:** Ambiguous or complex images get interpreted in the simplest possible way, since that takes the least cognitive effort.
**Mechanism:** The brain avoids unnecessary processing and snaps to the cleanest pattern that fits, rather than sitting with ambiguity.
**Origin:** 1910, psychologist Max Wertheimer, observing a series of railroad crossing lights that appeared to be one moving light rather than separate bulbs turning on and off.
**Apply it:** Icon and logo design especially. If a shape or layout could be read multiple ways, design toward whichever simple reading you actually want.

### Law of Proximity
**Rule:** Objects placed near each other are perceived as a group, even without a border or shared color.
**Mechanism:** The simplest Gestalt grouping cue, since it needs no additional design element beyond spacing. Users sort content into clusters at a glance using gaps alone, before reading anything.
**Origin:** Gestalt psychology.
**Apply it:** Use spacing itself as a grouping tool: tighten gaps between related elements, widen gaps between unrelated ones. Inconsistent spacing is one of the fastest ways to make a layout feel confusing.

### Law of Similarity
**Rule:** Visually similar elements (color, shape, size) are perceived as one type of thing, even when physically separated.
**Mechanism:** Similarity works through shared attributes rather than closeness. Learn the pattern once (e.g. all links are blue and underlined), recognize it anywhere after.
**Origin:** Gestalt psychology.
**Apply it:** Keep functionally similar elements visually consistent across the entire interface — every link styled the same, every "sale" tag the same color, every clickable icon the same treatment.

### Law of Uniform Connectedness
**Rule:** Elements visually connected via lines, shared color, or frames are seen as more related than elements with no connection, even across distance.
**Mechanism:** Strongest of the grouping cues because it states the relationship explicitly through a connector, rather than implying it through spacing or matching style.
**Origin:** Gestalt psychology.
**Apply it:** Diagrams, flow indicators, subway-map-style visual connections, org charts. Use when related elements can't be placed physically close together.

### Miller's Law
**Rule:** Working memory holds about 7 items (±2). Group content into chunks of five to nine.
**Mechanism:** This is a hard cognitive limit, not a preference. Past the "channel capacity," people start making mistakes or forgetting earlier items.
**Origin:** 1956, George Miller, on the span of immediate memory and absolute judgment.
**Apply it:** Chunk navigation menus, lists, phone-number-style groupings, any content longer than ~7 items. If a list is longer, split into labeled subgroups.

### Occam's Razor
**Rule:** Among equally effective options, choose the one with fewer assumptions.
**Mechanism:** Complexity has to earn its place. A more complex solution introduces more failure points and more cognitive load, so it needs to buy something the simpler option genuinely can't.
**Origin:** William of Ockham, English Franciscan friar and philosopher, early 1300s. A philosophical heuristic, not an empirical study.
**Apply it:** When two design or feature solutions accomplish the same user goal equally well, default to the one that's simpler to build, maintain, and understand.

### Pareto Principle
**Rule:** Roughly 80% of effects come from 20% of causes.
**Mechanism:** Most systems are lopsided, not balanced. Uniform effort across every part of a product wastes resources on parts that barely matter while underinvesting in the parts driving nearly all outcomes.
**Origin:** Vilfredo Pareto, economist, who noticed 80% of Italy's land was owned by 20% of the population.
**Apply it:** Use real usage data to find which small slice of features/pages drives most value, then direct the majority of design and engineering effort there instead of spreading it evenly.

### Parkinson's Law
**Rule:** Any task expands to fill however much time is available for it.
**Mechanism:** Time behaves elastically. A longer deadline doesn't produce better work, just slower work that fills the extra time through procrastination, over-polishing, or scope creep.
**Origin:** Cyril Northcote Parkinson, The Economist, 1955.
**Apply it:** Not strictly a visual design law, but relevant to scoping design and dev time. Set tighter deadlines deliberately rather than open-ended ones.

### Postel's Law
**Rule:** Be liberal in what you accept from users, conservative in what you send back.
**Mechanism:** Users are inconsistent by nature (typos, varied formatting). A rigid system that rejects slightly-off input punishes normal human behavior. Better to absorb inconsistency internally and show the user something clean.
**Origin:** Jon Postel, early internet pioneer. Also called the robustness principle, originally for TCP/networking.
**Apply it:** Form fields that accept varied input formats (phone numbers with or without dashes) and auto-normalize them. Search that corrects misspellings instead of returning zero results.

### Serial Position Effect
**Rule:** People remember the first and last items in a sequence best.
**Mechanism:** Combines the primacy effect (early items get more rehearsal, move into long-term memory) and the recency effect (last items are still fresh in short-term memory at recall). Middle items get neither advantage.
**Origin:** Term coined by Hermann Ebbinghaus.
**Apply it:** Place the most important item first or last in any list, nav menu, or sequence. Bury lower-priority items in the middle.

### Tesler's Law
**Rule:** Every system has a certain amount of complexity that can't be removed, only moved between the system and the user.
**Mechanism:** Complexity is conserved, not eliminated. The real design decision is who absorbs it — the design/engineering team once, or every user repeatedly.
**Origin:** Larry Tesler, Xerox, mid-1980s: engineers should spend an extra week reducing complexity rather than making millions of users spend an extra minute dealing with it. Counterpoint from Bruce Tognazzini: people actually resist having complexity removed from their lives, and simplification often just frees users to attempt more complex tasks.
**Apply it:** Absorb complexity on the backend/design side (autocomplete, smart defaults, automated matching) rather than pushing it onto every user.
**Watch for:** The Tognazzini counterpoint is a genuine open question, not settled. Don't assume simplifying is automatically correct in every case.

### Von Restorff Effect
**Rule:** When multiple similar objects are present, the one that differs is remembered best. Also called the isolation effect.
**Mechanism:** Memory favors contrast over repetition. A row of identical items blends into one group with no reference point; a pattern-breaking item forces separate processing, which is what makes it stick.
**Origin:** 1933, German psychiatrist/pediatrician Hedwig von Restorff.
**Apply it:** Make exactly one element (a primary CTA, a key stat) visually distinct from everything around it. Only works if used sparingly — if everything is distinct, nothing is.

### Zeigarnik Effect
**Rule:** People remember unfinished or interrupted tasks better than completed ones.
**Mechanism:** An unfinished task creates ongoing mental tension (an "open loop") the brain keeps active until closure. That tension pulls attention back to the task even without an external reminder.
**Origin:** 1920s, Soviet psychologist Bluma Zeigarnik.
**Apply it:** Progress bars that stop short of 100%, streaks, partially completed profiles or lesson trees. Effective for retention, but be mindful of the line between motivating and manipulative — don't manufacture false incompleteness just to trigger anxiety.
