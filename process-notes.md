# Process notes (draft)

Moments get drafted here as they happen, while the why is still fresh —
see `CLAUDE.md`. This is scratch, not the graded file: the strongest
entries get promoted into `PROCESS.md` later, by hand, curated down to
the three or four that show real judgement.

## Manual verification exposed a design flaw, not a tuning problem

1. **What happened** — the first version of `rhythm.ts` treated every
   detected audio onset as a required-click turn point. It typechecked,
   had passing unit tests on synthetic data, and looked reasonable from
   console-logged gap statistics (min/mean/max onset spacing). None of
   that caught the actual problem: a dev-only tool
   (`rhythm-debug.ts`) was built specifically to let a human see the
   detected onsets on a timeline *and* hear them clicking against the
   real track at the same time — and using it against the real audio
   showed the opening section packing onsets close enough together that
   a brand-new player would have to react correctly within the first
   couple of seconds. That directly works against the spec's
   self-teaching / obvious-in-10-seconds requirement, and no automated
   check was positioned to catch it, because the problem was a judgment
   call about feel, not a wrong number.
2. **What I did instead of the obvious thing** — the obvious fix would
   have been to tune the numbers: raise `thresholdFactor`, widen
   `minSpacingSeconds`, until the opening looked sparse enough. Instead,
   the question was whether the *design* was wrong: should every onset
   really require a click? A short check into how the reference game
   (Dancing Line) and rhythm-game charting generally work confirmed it
   shouldn't — charts put required input on the strong/accented beats,
   not every detected onset, and difficulty ramps by progressively
   admitting weaker onsets over time, not by loosening timing tolerance.
   So `rhythm.ts` gained a real second concept (onset *strength*, kept
   from the detector's own adaptive-threshold ratio instead of thrown
   away) and a `markTurns` function that splits onsets into required
   turns vs. visual-only decoration via a percentile threshold that
   ramps down over the first ~30 seconds — the difficulty curve is now a
   property of *which* onsets require input, not a threshold tweak on
   the existing rule.
3. **How I knew it was right** — re-ran the same dev-only visual+audio
   tool against the real track after the change: the opening section now
   shows only a handful of tall, bold turn-ticks with a loud, distinct
   click, while the denser onsets render as short, pale decoration ticks
   with a soft click layered underneath — visibly and audibly sparser at
   the start, denser later, without having touched the underlying
   detection thresholds. `pnpm check` stayed green throughout (38/38
   tests, including new tests asserting the ramp actually admits weaker
   onsets later without them getting stronger).
4. **The citation** — the redesign itself:
   [`75ca780`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/75ca780).
   The harness change this produced — a new `CLAUDE.md` section
   requiring judgment-call work to be built and manually checked in
   small, human-verifiable steps rather than checked only at the end —
   lands in the commit that follows this note.

> "Are these blue lines the points that will become the turning points on
> the map? The opening section has way too many action points packed
> together. Not every onset/beat point should require the user to click.
> Requiring clicks this frequently right at the start is too hard for new
> players — the difficulty should ramp up gradually. Can you detect the
> accented/stressed beats in the music? Only set a turn requirement at the
> accented beats; the other beats can be represented as visual decoration
> on the map instead. Also, look into how the original Dancing Line
> actually designed this more carefully."

## Autonomous tuning stalled; human-specified exact corrections worked

1. **What happened** — several rounds of timing/difficulty adjustment
   were done as open-ended "make it feel better" passes: widen the
   corridor, decouple the tolerance from the visual width, tune
   `thresholdFactor`/spacing, and re-check via gap statistics or a quick
   look, without the human pinning down the exact number or exact
   moment that was wrong. That pattern (see `e6842cd`, `91e6e29`) took
   several commits to actually land on a working tolerance model, and
   the underlying design was still wrong underneath the patches (see the
   note above and `2ef5c45`'s full redesign).
2. **What worked instead** — once the human did the actual manual
   observation (playtesting, listening) and came back with a precise,
   falsifiable complaint — "the death time doesn't match the time of the
   wrong click," not "the timing feels off" — the fix stopped being
   guesswork. Instead of tuning by feel, the exact real constants
   (`ROUTE_SPEED`, `CORRIDOR_HALF_WIDTH`) were plugged into
   `lateralOffset` directly to compute the actual click-vs-death gap
   (150ms, and showed a late click could register death *before* the
   click itself), which pinpointed the root cause precisely enough to
   pick a targeted correction — tighten both knobs together, not
   guess-and-check one — verified by re-running the same computation
   before touching any code the human would then have to re-test.
3. **The lesson** — for interactions where correctness is about *feel*
   (timing, difficulty, responsiveness), letting the AI self-tune
   against its own proxy signals (stats, "looks reasonable") doesn't
   converge — the human has to be the one supplying the ground truth
   (an exact symptom, an exact timestamp), with the AI's job being to
   turn that into a precise, verified diagnosis and fix rather than
   another round of guessing. This is the same shape as the first entry
   above (manual verification over automated proxies) but sharper: the
   proxy that failed here wasn't a missing check, it was the AI
   iterating on its own without a human-supplied ground truth to anchor
   each round.
4. **The citation** — the fix itself:
   [`ef2dd49`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/ef2dd49).
   Contrast with the earlier undirected tuning rounds:
   [`e6842cd`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/e6842cd),
   [`91e6e29`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-YueheSun/commit/91e6e29).
