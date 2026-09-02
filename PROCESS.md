# Process overview

A reading-guide to how the work came together — a map to your process, not an
essay about it. Markers read this file and follow its citations.

This file is the shape; the course site's
[assessment page](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#what-you-submit)
is the requirement, and its
[word counts](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#word-counts)
cover every deliverable.

## What I built

A Dancing-Line-style rhythm game: a track's onsets are detected and split
into required turns (the accented/strong beats) versus visual-only
decoration, a corridor is generated from that rhythm, and a line moves
forward at constant speed while the player clicks to turn it 90° and steer
it down the corridor — wander off the real wall geometry and it's a crash.
At the end of a successful run the camera pulls back to show the whole
path traveled; a death just freezes in place.

## The moments that mattered

1. **A dev-only visual+audio tool exposed a design flaw a passing test
   suite couldn't.** The first turn-detector treated every audio onset as
   a required click, and it typechecked, had green unit tests, and looked
   fine in console-logged gap statistics. Only a purpose-built tool that
   let a human see the detected onsets on a timeline *and* hear them
   against the real track showed the actual problem: the opening packed
   onsets close enough together that a new player would have to react
   correctly within the first two seconds, directly working against the
   spec's self-teaching requirement. Instead of tuning thresholds to hide
   it, I checked how rhythm-game charting and the reference game actually
   work, and gave `rhythm.ts` a real second concept — onset *strength* —
   so a `markTurns` pass splits required turns from decoration via a
   percentile threshold that ramps down over the first ~30 seconds. Fixed
   this way, re-running the same tool showed a visibly and audibly sparser
   opening without touching the detection thresholds at all, and it
   produced a harness change, not just a fix: `CLAUDE.md` gained a
   standing rule that judgment-call work (feel, timing, anything parsed
   from real input) has to be built and manually checked in small,
   human-verifiable steps rather than validated only at the end.
   [`75ca780`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/75ca780)

   > "Are these blue lines the points that will become the turning points
   > on the map? The opening section has way too many action points
   > packed together. ... Requiring clicks this frequently right at the
   > start is too hard for new players — the difficulty should ramp up
   > gradually. ... Also, look into how the original Dancing Line
   > actually designed this more carefully."

2. **Letting the AI self-tune feel against its own proxies didn't
   converge; a precise human complaint did.** Several rounds of timing
   adjustment — widen the corridor, decouple tolerance from visual width,
   retune spacing — were open-ended "make it feel better" passes checked
   against gap statistics or a quick look, and the underlying model was
   still wrong underneath the patches. The fix only landed once the human
   came back with an exact, falsifiable complaint — "the death time
   doesn't match the time of the wrong click," not "the timing feels
   off" — which let me plug the real constants into the offset
   calculation, compute the actual click-vs-death gap (150ms, and a late
   click could register death *before* the click itself), and pick a
   targeted, verified correction instead of guessing again. The lesson:
   for feel/timing work, the human has to supply the ground truth (an
   exact symptom, an exact instant); the AI's job is turning that into a
   precise diagnosis, not iterating alone on proxy signals.
   [`ef2dd49`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/ef2dd49),
   contrast with the undirected rounds before it:
   [`e6842cd`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/e6842cd),
   [`91e6e29`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/91e6e29).

3. **A "rendering-only" fix got reverted outright once traced to a design
   flaw, not patched with a tuning knob.** Recentering the player's line
   at each corner (a real crash-tolerance fix) made the drawn dot snap to
   centerline every turn; a playtest report that it "jerks/shakes" led to
   an eased blend between the old and new segment's offsets. The very
   next playtest called the result worse — a visible 45° diagonal cutting
   the inner corner. Rather than shorten the ease window or cap the blend
   distance, I re-derived the geometry by hand: a 90° turn rotates the
   whole coordinate frame, so the two segments' sideways axes are
   *perpendicular*, and any straight-line blend between offsets measured
   on each necessarily draws a diagonal shortcut across the corner. That's
   a structural property of the approach, not a tunable side effect, so
   the fix was to delete the blend entirely rather than reshape it —
   PLAN.md's write-up was rewritten, not appended to, so a future attempt
   wouldn't re-derive the same dead end from scratch.
   [`cc7d69d`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/cc7d69d)

4. **A claim written into the plan as settled fact was never actually
   checked, and cost two whole rounds before a screenshot forced it.**
   PLAN.md stated, across two rounds, that the rendered corridor wall
   "matches `hasCrashed`'s real hitbox exactly." That was never true —
   `hasCrashed` was judging a single rotating offset axis with no concept
   of wall geometry, so there was nothing for a rendered fillet to match
   in the first place. Because the claim was already sitting in the plan
   as settled, two rounds went into getting the corner *shape* exactly
   right (convex vs. concave constructions, pixel-level fill-rule
   debugging) in service of matching a hitbox the collision code didn't
   have. It only surfaced once the user came back with a screenshot and
   an explicit statement of intent, rather than another "the corner
   doesn't look right." That pointed me at the actual collision logic
   instead of another render pass, and a forward-scanning probe against
   the live, running code — not another hand-derivation — found the real
   single-axis, vertex-blind model in minutes. The lesson this produced:
   a doc's claim that two computations "match" or "are the same fact" is
   a testable claim, not a design summary, and needs the same evidence as
   a bug fix (checked against the real running function) before later
   rounds are allowed to build on it.
   [`898b8d7`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/898b8d7),
   contrast with the false claim it corrected:
   [`4f26683`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/4f26683).

   > "We thought the corridor wall and the collision/failure judgment had
   > already been tied together, and even wrote that into PLAN.md — but
   > the code actually never did this at all. We spent a long time
   > obsessing over the corner shape before finally realizing the real
   > problem was in the collision logic itself. It was only by providing
   > a screenshot plus a detailed description that the AI was able to
   > debug it correctly, in line with what I actually meant."
