# PLAN.md — working plan for C5 (a rhythm-line game)

Not the spec (see `spec/README.md`) and not `PROCESS.md`. This is the living
build plan: reasoning behind decisions, current state, and next steps for
whoever (agent or me) picks this up next. Update it at phase boundaries, then
`/clear` and reload with `@PLAN.md`, per `CLAUDE.md`.

## Status (turn design confirmed good enough by the user — see bottom; step 4 is next)

**Resolved as of this update.** The accent/ramp version was re-checked
against the debug tool and the user gave three concrete complaints: turns
started immediately at track-start instead of waiting for the music to
actually begin; the second half was too sparse; and to look at how
Dancing Line spaces turns relative to tempo. Rather than guess at tuning
knobs, the real track was decoded outside the browser (ffmpeg via a
throwaway Python venv) and `detectOnsets`/`markTurns` re-run in Python
against it to get hard numbers, and the user's score PDF
(`src/assets/music/萤火虫之怨.pdf`, ♩=96, continuous 16th-note
figuration) was read for context. That surfaced two distinct, confirmed
bugs (not preference calls):

1. **Bogus early "turns"** — true silence before the first note produces
   a near-zero `localAverage`; dividing a near-zero energy by it inflates
   `strength` into nonsense. Fixed with `SILENCE_FLOOR_FRACTION = 0.02`
   (an onset candidate must also clear this fraction of the *track's own*
   mean windowed energy — track-agnostic, no fixed absolute amplitude).
   On top of that, the user initially asked for an explicit "just watch"
   window (`TurnRampOptions.minStartSeconds`, 4.7s) forcing `isTurn: false`
   before that point regardless of strength — **later removed** (see
   round-3 below): turns are now allowed from t=0, gated only by the
   percentile ramp itself.
2. **Second-half blind spot** — a 0.5s rolling-average window is longer
   than several 16th notes at this tempo (0.156s each), so in a
   continuous, uniformly-loud run it stops seeing note-to-note attacks at
   all (confirmed: zero onset candidates for a 13s stretch at
   t≈88.5–101s, at any threshold). This was a wrong assumption in the
   algorithm (averaging timescale picked without reference to note rate),
   not a constant to tune. Fixed by shrinking
   `DEFAULT_OPTIONS.averageWindowSeconds` 0.5→0.15 and `thresholdFactor`
   1.5→1.2. Verified against the real track: onsets 100→229, the dead
   88.5–101s stretch now has regular turns, turn-gap balance is close
   across the whole track (first-half mean gap 1.22s, second-half 1.35s;
   max gap down from 20s to 3.92s).

No published Dancing-Line turn-spacing numbers exist (searched); general
rhythm-charting practice confirms the ramp *shape* (strong-beats-only →
near-every-note as difficulty/time increases) but supplied no number to
import directly — the ramp above already had that shape.

**User's final verdict on this round:** second half is dense enough now,
and "honestly the whole track looks a bit too dense at this point" —
but explicitly said to leave it as-is and move on to step 4, planning to
keep tuning once the renderer exists to look at. So the plan's Step 3
(local/windowed percentile instead of one whole-track percentile, plus a
max-gap backstop) was **not implemented** — noted below as deferred, not
abandoned, since "a bit too dense overall" is the opposite direction from
what Step 3 would have fixed (it only guarantees a max gap, it doesn't
reduce density). If density comes up again, look at `startPercentile`/
`endPercentile` or `thresholdFactor` first, not Step 3.

Built and green (`pnpm check`: typecheck, build, 41 tests across 4 files):

- **`src/scripts/rhythm.ts`** — onset detection, as scoped below, **plus an
  accent/turn-selection layer added after playtesting the verification
  tool** (see "Design correction" below — this superseded the original
  "every onset is a corner" assumption). `detectOnsets` now returns
  `Onset[] = { time, strength }[]`, where `strength` is the onset's energy
  divided by its local rolling average — the same adaptive-threshold ratio
  the detector already computed internally, just kept instead of thrown
  away, so this cost nothing extra to add. `thinOnsets` was changed to keep
  the *stronger* of two colliding onsets rather than just the earlier one.
  A new `markTurns(onsets, rampOptions)` buries the difficulty ramp: each
  onset's strength is converted to a percentile within the whole track's
  strength distribution, and the percentile required to count as a turn
  decreases linearly from `startPercentile` (0.9) to `endPercentile` (0.45)
  over `rampSeconds` (30s) — so the opening ~30s only turns on the loudest
  ~10% of onsets, and by 30s in roughly the top half qualify. Onsets that
  don't clear the bar are still returned (as `Beat.isTurn === false`) for
  decoration, not dropped.

  Sanity checked against the real track
  (`src/assets/music/闫东炜 - 萤火虫の怨.mp3`, 160.9s) via a dev-only
  visual+audio verification tool, `src/scripts/rhythm-debug.ts`, mounted
  from `main.ts` (`import.meta.env.DEV`-gated, tree-shaken out of the
  production build — confirmed by grepping `dist/`, nothing rhythm-related
  survives the build). After the round-2 fixes below: 229 onsets, turn-gap
  min/mean/max = 0.38/1.28/3.92s, balanced across the track (first-half
  mean gap 1.22s, second-half 1.35s). Has its own colocated sanity tests
  (`src/scripts/rhythm.test.ts`, synthetic burst data, now covering
  `markTurns`'s ramp behaviour, the silence floor, and a dense
  evenly-loud burst train) — these are engineering confidence, not
  the spec's required test (see next).

  **Design correction, found by using the verification tool, not by
  re-reading code:** the first version treated every detected onset as a
  required-click turn. Watching+listening to the real track exposed that
  the opening section packs onsets close enough together that a brand-new
  player would need to react correctly within the first couple of seconds
  — directly working against the spec's self-teaching/10-second-legibility
  requirement (see Alignment below). Quick research into how the reference
  game (Dancing Line) and rhythm-game charting generally handle this
  confirmed the fix: charts don't put a note on every detected onset —
  easier sections/difficulties use only the strong, accented, on-the-beat
  hits (downbeats), and note *density* ramps up over a track or across
  difficulty tiers by progressively admitting weaker/off-beat onsets, not
  by changing timing tolerance. That's exactly the `markTurns` percentile
  ramp above: strength stands in for "accent," and the required-strength
  bar loosens over time instead of being fixed. This is the kind of moment
  `CLAUDE.md` asks to capture in `process-notes.md` — the fix landed in the
  harness (a new function + its own tests + the debug tool now showing the
  distinction), not in a retry of the old approach.

- **`src/scripts/track.ts`** — the one core rule. **Rewritten after a
  playtest correction** (see "Mechanic: real wall collision" below for the
  full explanation) — the first version (`resolveCorner`/`runRoute`)
  compared click *timestamps* to corner *timestamps* within a fixed
  tolerance window, with the player's dot always rendered on the ideal
  precomputed corridor regardless of how accurate the clicks were. That
  matched none of "off the corridor = death" as originally scoped below —
  a playtest showed clicks landing wrong with nothing visibly going wrong,
  and separately caused a premature-death bug (judging a corner "missed"
  the instant its nominal time passed, before a legitimately-late click's
  own grace window had closed). The rule is now genuinely spatial:
  `lateralOffset(cornerTimes, clickTimes, time, speed)` walks both the
  ideal corridor and the player's own click-driven path forward (via
  `route.ts`'s `walkTurns`, fed corner times and click times
  respectively) and returns how far sideways the two have diverged at
  `time`; `hasCrashed(..., halfWidth)` is `|lateralOffset| > halfWidth`.
  Since both walks move at the same constant speed regardless of heading,
  "sideways drift at the same elapsed time" is well-defined without full
  polygon collision. `CORNER_TOLERANCE_SECONDS` is gone as a concept —
  `CORRIDOR_HALF_WIDTH` (in `game.ts`) is now the *only* difficulty/visual
  knob, since crossing it is what a wall hit literally means.
- **`spec/game-rule.test.ts`** — the spec's required "one rule under a
  focused automated test," importing `hasCrashed`/`lateralOffset`
  directly. Cases: perfect clicks never crash; an early or late click
  within the divergence window (`halfWidth / speed`) survives; a click
  further off than that crashes before the corner even arrives (the
  "immediate failure on a mistimed click" behaviour); a missed click
  drifts into a crash shortly after the corridor's own turn; a stray click
  on a straight stretch crashes; an explicit "a wrong move is always
  possible" case that drops exactly one click out of a 5-corner route and
  asserts every one of them eventually crashes — this is the test that
  backs the spec's "losable" requirement, not just a unit test of
  convenience.

**Not yet built:** the end-of-run zoom-out. That's step 5 below (step 4,
the renderer + input loop, is built — see "Mechanic" below for its
current shape).

## Mechanic: real wall collision (redesign, supersedes the tolerance model above)

Playtesting the step-4 renderer surfaced that the tolerance model above was
a wrong simplification of the mechanic actually scoped in "The idea, as
given" and "Feasibility" below (which already said: "a click reverses the
current turn direction... if the corner direction doesn't match where the
corridor actually turns, the dot goes off the corridor edge and dies") —
the dot was always drawn on the ideal centerline no matter how a click
landed, so "off the corridor and dies" was never actually implemented.
This section is the corrected mechanic, now built:

- The corridor (`route.points`) is unchanged: the fixed, beat-derived
  sequence of 90°-turn segments, drawn as a thick stroked corridor whose
  edges (±`CORRIDOR_HALF_WIDTH` from the centerline) are the walls.
- The player's line has its **own live path**, independent of the
  corridor: `route.ts`'s `walkTurns(clickTimes, elapsed)` walks it forward
  at the same constant `ROUTE_SPEED`, turning 90° at every click —
  correct or not. There's still only one button (no separate left/right
  choice), so a click's only effect is *when* the line turns, never which
  way.
- Every frame, `track.ts`'s `hasCrashed(route.turnTimes, clickTimes,
  elapsed, CORRIDOR_HALF_WIDTH)` measures how far sideways the line's
  actual path has drifted from the corridor's centerline (projected onto
  the corridor's current direction of travel) and ends the run the moment
  that exceeds the corridor's half-width. A click that's early, late, or
  never comes causes the two paths to diverge; divergence grows at a rate
  of `ROUTE_SPEED` once the two are no longer moving in the same
  direction, so a wrong click reaches the wall in `CORRIDOR_HALF_WIDTH /
  ROUTE_SPEED` seconds — a genuine geometric consequence rather than a
  tuned flag, but still a real, measurable lag between the wrong action
  and the observed death (see round-3 below for a case where this lag
  actually matters).
- Rendering (`game.ts`): the dot and its trail are drawn at the line's own
  simulated position, not the corridor's centerline, and the camera
  follows that real dot — so a mistimed click is now visible on screen as
  the dot drifting off the drawn corridor and crossing its edge, which is
  what a wall hit is supposed to look like.
- `CORRIDOR_HALF_WIDTH` in `game.ts` is now the single knob controlling
  both how wide the corridor looks and how much timing slack a click
  actually gets — the earlier bug (widening the corridor visually did
  nothing to the actual hit judgment, since two different numbers were
  responsible for each) can't recur, because there's only one number now.

**Round-3 playtest finding:** "the death time doesn't match the time of
the wrong click." Diagnosed by directly computing `lateralOffset` against
the real constants (`ROUTE_SPEED=140`, `CORRIDOR_HALF_WIDTH=20` at the
time) rather than guessing: an early click at t=4.7 against a corner at
t=5 killed the run at t=4.85 (150ms *after* the click); a late click at
t=5.3 killed the run at t=5.15 — *before* the late click even happened,
since divergence starts at the corridor's own turn instant, not at
whenever a late click eventually arrives. Not a bug in the collision
math (verified correct) — it's `CORRIDOR_HALF_WIDTH / ROUTE_SPEED`
(≈143ms), inherent to modeling this as a real spatial collision at all.
Fix was to tighten both knobs rather than just one, to shrink the ratio
without over-narrowing the corridor on its own: `ROUTE_SPEED` 140→300,
`CORRIDOR_HALF_WIDTH` 20→12, lag ≈143ms→40ms (under the ~100ms
simultaneity threshold). Trade-off: `ROUTE_SPEED` also sets how many
seconds of upcoming corridor fit in the viewport at once (the "seeing the
path coming" affordance) — raising it shortens that lookahead — so this
wasn't a free tuning knob, worth another look if lookahead ever feels
too short.

## The idea, as given

Dancing-Line-style game: parse the rhythm of a music track to generate a
route map; a line moves forward at constant speed; each click flips its
direction; the player steers it along the generated route and off the track
= death; at the end the camera pulls back to a top-down view of the whole
path traveled. `music/` holds one track now, more will be added later, and
the map generator must work on whichever track is loaded — it can't be
hand-authored per song.

## Feasibility

Client-side only, which is what C5 requires (static, GitHub Pages, no
backend) — everything below runs in the browser with the Web Audio API and
`<canvas>`. Nothing here needs a server.

**Rhythm → map generation is the part that determines scope.** True
beat-tracking (tempo estimation, downbeat detection, genre-robust onset
detection) is a real DSP problem — doable in JS, but "doable well" is a
rabbit hole, and the brief wants a mechanic that's obvious in ten seconds,
not a beat-tracker. The cheap version — decode the file with
`AudioContext.decodeAudioData`, compute short-window RMS energy across the
buffer, pick local peaks above an adaptive (rolling-average) threshold as
"onsets," then thin them to a minimum spacing — is a well-known, ~40-line
technique and is plenty to turn a real track into a sequence of turn points
that *feels* like it follows the music, without claiming to be
musicologically correct. That's the right scope for a prototype: good
enough that the generated map is obviously tied to the track (test this by
ear against a couple of different songs), not a research-grade beat
tracker. **Verdict: feasible, scope the algorithm down to energy-onset
peak-picking.**

**Line-follows-a-corridor-you-steer is exactly Dancing Line's mechanic** and
is cheap in 2D canvas: represent the route as a polyline of straight
segments meeting at turns; the player's dot moves along it at constant
speed; a click reverses the current turn direction (left/right) at the next
corner; if the corner direction doesn't match where the corridor actually
turns, the dot goes off the corridor edge and dies — see "Mechanic: real
wall collision" in Status above for exactly how this is now implemented
(the first pass under-built this and was corrected after playtesting). No
3D engine needed —
Dancing Line's "3D" look is a skinned camera angle on what is mechanically
a 2D forward-scroller; a top-down or fixed-angle 2D canvas view is faithful
to the mechanic, not a simplification of it.

**Camera pull-back at the end** is cheap *if* the game's live view is
already top-down or a fixed angle on the same 2D world — it's a canvas
pan/zoom tween to fit the whole traveled polyline in frame, not a camera
system. If the live view were first-person or an angled "3D" perspective,
this would need actual scene/camera work; that's the reason to choose a
top-down or gently-angled fixed view for the live game too (see Scope
below), so the ending is a tween, not a second rendering mode.

## Alignment with the C5 spec

Checked against `spec/README.md` and the fetched brief
(`crits/05-game/`):

- **Static/client-side/GitHub Pages** — yes, nothing here needs a backend.
- **Losable, ends in win/loss/finish** — yes: off-corridor = loss,
  reaching the end of the generated route = finish. This is the natural
  shape of the mechanic, not bolted on.
- **Self-teaching, no tutorial, obvious in 10s** — yes, *if* the first
  stretch of every generated route starts dead straight for ~2 beats before
  the first turn. A stranger presses play, the dot moves, does nothing,
  hits the first corner, dies in under 5 seconds — that failure **is** the
  tutorial. This only works if turn 1 is close to the start; needs to be a
  generation rule, not left to chance.
- **Reachable ending within 5 minutes for a stranger** — a *loss* counts as
  an ending per the spec ("win, loss, or finish"), so this is satisfied
  almost trivially by the self-teaching property above. But a stranger
  should also be able to reach a *finish* inside 5 minutes on a lucky or
  skilled run, so the MVP level should be a short clip (~45–75s of audio),
  not a full 4–6 minute track — see Scope.
- **One rule under a focused automated test** — the turn-timing/collision
  check is a pure function of (route, position, chosen direction) with no
  DOM/canvas/audio dependency, so it's directly unit-testable. Concrete
  candidate below.
- **One change from playtesting, not code review** — can't plan this in
  advance; note it in `PROCESS.md` once it happens (e.g. turn-warning
  timing, minimum straight-run length, click debounce).
- **Two marking viewports + no instructions anywhere** — canvas needs to
  scale to both; zero copy on the page beyond the canvas itself.

No part of the brief conflicts with the idea. The risk is entirely scope
creep — beat-tracking, 3D camera work, multi-track menus, and the top-down
reveal can each expand past "one mechanic" if built first. The plan below
cuts to the one mechanic and defers everything else explicitly.

## Scope: smallest playable version

**One core mechanic:** click reverses the line's turn direction at each
upcoming corner; stay on the corridor or die. Route corners are placed by
the rhythm-detection pass over the loaded track, not hand-authored.

**In scope for MVP:**
1. Load one track (the existing file), decode it, run energy-onset
   detection, generate a route (sequence of straight segments + 90° turns,
   minimum straight length enforced, clipped to the first ~45–75s of the
   track).
2. Draw the corridor and the moving line from a fixed top-down (or
   near-top-down) angle, scrolling/panning to keep the dot roughly centred.
3. Click/tap = toggle direction. Off-corridor = immediate loss. Reaching
   the last generated corner = finish.
4. On loss or finish: freeze, tween the camera out to frame the entire
   traveled path top-down (this is cheap precisely because the live view is
   already top-down — see Feasibility).
5. Opening screen is just the game, already moving, with no text — the
   first straight-then-turn stretch is the entire onboarding.
6. One vitest-covered pure function: given a route and a stream of
   "direction at corner N" decisions, does it return the correct
   dead/alive/finished state and position. This is the "focused automated
   test."
7. Beat-synced pulse: flash/recolour the corridor (or background) at each
   detected beat timestamp — turns *and* decoration onsets alike, so the
   non-turn beats aren't wasted detection work, they're what makes the
   quieter stretches still visibly tied to the music. Cheap — the rhythm
   pass already produces these timestamps, so this reuses that data — and
   it's the one enrichment that visibly proves the map came from *this*
   track, which is the idea's whole premise. In scope because it's
   near-free, not because visuals matter for the mark.
8. Fading trail behind the moving dot showing the path just travelled.
   Also cheap (a capped-length array of past positions, drawn with
   decreasing alpha) and it doubles as a free preview of the end-of-run
   zoom-out, so it's paying for itself twice.

Both 7 and 8 are additive to the renderer only — neither touches the pure
route/step logic, so they can be added or ripped out without risk to the
one mechanic or its test.

**Explicitly deferred (not this pass):**
- Multiple track selection / a track picker UI — for now hardcode to the
  one file in `music/`; wire up a simple manifest (see Open questions)
  only once the single-track loop is fun, so multi-track doesn't become
  the thing that eats the week.
- Difficulty tuning, obstacles beyond "the corridor edge," combo/score
  systems, visual polish beyond legibility.
- Any real beat-tracking (tempo/downbeat estimation, genre adaptation) —
  energy-onset peak-picking only.
- **Angled/tilted "3D" Dancing-Line skin** — considered and deliberately
  cut. Feasible (it's a rendering transform on top of the same
  view-agnostic `step` function, so it wouldn't touch game logic), but a
  tilted/perspective view makes "which way does the corridor turn, right
  now" harder to read at a glance — and that judgment is the entire
  mechanic. Flair that costs legibility is exactly the kind of thing that
  eats the week instead of the one mechanic. Top-down fixed view only for
  the MVP.
- **Turn-punch** (a brief ~100ms canvas rotation on each turn, snapping
  back immediately) as a stand-in for the tilt above — a taste of "banking"
  feel without a sustained perspective. Explicit post-playtest stretch:
  only add it once the flat top-down version has been played by a
  stranger and legibility is confirmed to not be the bottleneck. Don't
  build it alongside the MVP.

Two mechanics interacting (e.g. speed-up sections, obstacles that aren't
just the corridor edge) is explicitly the "harder, better move" per the
brief — worth reaching for only after the one-mechanic version is obviously
solid and self-teaching.

## Concrete technical plan

**Audio location:** `music/` at repo root isn't served by Astro — only
`public/` is copied verbatim to `dist/`, and only `src/` goes through Vite.
Move the track(s) into `src/assets/music/` and load them with
`import.meta.glob('/src/assets/music/*.mp3', { eager: true, query: '?url' })`
so a newly dropped-in file (per "more music files will be added later")
needs no code change — glob picks it up automatically. Hardcode "use the
first entry" for MVP; a picker is deferred.

**Rhythm parsing** (`src/scripts/rhythm.ts`, pure, no DOM) — steps 1–4 are
built (see Status above); 5–6 are the still-to-build route-shape step:
1. `fetch(url) → arrayBuffer → AudioContext.decodeAudioData` → `AudioBuffer`.
2. Downmix to mono, compute RMS energy over ~20ms windows.
3. Adaptive threshold: local peak > rolling average × factor → onset
   (time + strength).
4. Thin onsets to a minimum spacing (e.g. ≥0.4s, preferring the stronger of
   two colliding onsets), then run `markTurns` to split onsets into
   required turns vs. visual-only decoration via the difficulty ramp (see
   Status above for why and how).
5. Map **turn** onsets → alternating-ish left/right turns at a constant
   forward speed, converting each onset's time offset into a distance along
   the route; decoration onsets get a position along the route too, but no
   turn. Force the first turn to be at least N onsets in / a fixed minimum
   straight length, per the self-teaching requirement above — the ramp
   mostly guarantees this already (the loudest onset early on is rarely the
   very first one), but don't rely on that alone.
6. Output: `{ segments: {dx, dz}[], decorations: {distance}[] }` or
   equivalent — plain data, easily unit-tested without touching canvas or
   audio playback.

**Game state / the testable rule** — built as `src/scripts/track.ts`;
see "Mechanic: real wall collision" in Status above for the actual shape
(`lateralOffset` + `hasCrashed`, built on `route.ts`'s `walkTurns`, no
separate direction input). Matches the "no DOM/canvas/audio dependency"
goal here.

**Route shape for rendering** (still to build, e.g. in `rhythm.ts` or a
new small module): beat times alone aren't a drawable path — need a step
that turns `markTurns`'s output into a polyline (alternating
horizontal/vertical 90° segments **only at `isTurn` beats**, first turn
far enough in for the self-teaching requirement, clipped to ~45–75s) plus
a separate list of decoration marker positions (`isTurn === false` beats)
for the beat-synced pulse (Scope item 7) to flash on, without those beats
affecting the corridor shape at all. `runRoute`/`resolveCorner` don't need
any of this — they only need the turn timestamps — so this step is purely
for what the canvas draws.

**Rendering & input** (`src/scripts/game.ts` + canvas in the page):
`requestAnimationFrame` loop tracks elapsed seconds since start (constant
speed, so elapsed time = position along the route), feeds click
timestamps and the route's corner timestamps to `runRoute` (or calls
`resolveCorner` incrementally corner-by-corner as they're passed, which
is the same rule applied live rather than replayed), draws the polyline
+ dot from the route shape above, and a click/tap/keypress records a
click timestamp. On terminal state (`"dead"`/`"finished"`), run the
zoom-to-fit tween.

**Page:** replace the template `index.astro` content with just the canvas
(no copy, per no-tutorial) — head/meta/card conventions from `CLAUDE.md`
stay as-is.

## Open questions (my calls, flagged for revisit)

- **Manifest vs. glob for multi-track:** going with `import.meta.glob` (no
  manifest file to maintain) unless it proves awkward once a picker exists.
- **Route shape:** 90°-only turns (Dancing-Line-classic) vs. arbitrary
  angles. Starting with 90° — simpler corridor collision math, and matches
  the reference game's affordance (a click always means "turn," period).
- **Input:** single click/tap/spacebar all mean the same "toggle" action;
  no separate left/right controls — keeps the one-mechanic framing honest
  (there's one button, not two).

## Next steps, in order

1. ~~Move music into `src/`~~ — done, confirmed at
   `src/assets/music/闫东炜 - 萤火虫の怨.mp3`, matches the glob pattern.
2. ~~Write `rhythm.ts` + sanity-check it~~ — done, see Status above.
3. ~~Write the pure rule + its spec test~~ — done, see Status above.
3.5. ~~Add accent detection + a difficulty ramp so only strong onsets
   require a turn~~ — done, see Status above (`markTurns`); re-checked
   with the debug tool a second time, two real bugs found and fixed
   (silence gate + `minStartSeconds`, shortened averaging timescale — see
   Status above), user confirmed the result is good enough to build on.
   Step 3 of the round-2 fix plan (local/windowed percentile + max-gap
   backstop) was explicitly deferred, not done — see Status above for why
   and what to reach for instead if density comes up again.
   **← current checkpoint, now resolved. Update this file, `/clear`,
   reload `@PLAN.md` before continuing with step 4.**
4. Turn onset times into a drawable route shape (see Concrete technical
   plan above), then build the canvas renderer + input loop around
   `runRoute`/`resolveCorner`. Include the beat-synced pulse and fading
   trail (Scope, items 7–8) while building the renderer, since they're
   additive to it either way.
5. Add the end-of-run zoom-to-top-down tween.
6. Playtest cold at both marking viewports; capture the one change that
   comes out of that (not out of re-reading the code) for `PROCESS.md`.

Stop and checkpoint again after step 5 — that's the point where the game
becomes finishable/loseable end-to-end, not just correct in a test file.
