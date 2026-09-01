# PLAN.md — working plan for C5 (a rhythm-line game)

Not the spec (see `spec/README.md`) and not `PROCESS.md`. This is the living
build plan: reasoning behind decisions, current state, and next steps for
whoever (agent or me) picks this up next. Update it at phase boundaries, then
`/clear` and reload with `@PLAN.md`, per `CLAUDE.md`.

## Status (updated after the accent/ramp redesign — see bottom)

Built and green (`pnpm check`: typecheck, build, 38 tests across 4 files):

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
  survives the build). Raw onset count: 104, gap min/mean/max =
  0.44/1.48/13.18s. Has its own colocated sanity tests
  (`src/scripts/rhythm.test.ts`, synthetic burst data, now covering
  `markTurns`'s ramp behaviour too) — these are engineering confidence, not
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

- **`src/scripts/track.ts`** — the one core rule, and a clarified mechanic:
  corners and clicks are both plain **timestamps in seconds** (forward
  speed is constant, so time stands in for distance — no separate distance
  unit needed). **Updated by the redesign above:** a route's corner times
  are no longer *every* onset straight from `rhythm.ts` — they're
  `markTurns(onsets).filter(b => b.isTurn).map(b => b.time)`; the
  non-turn beats become decoration in the renderer instead (see Route
  shape below). `track.ts` itself needed no code change — `runRoute` only
  ever consumed generic timestamps, so this is entirely a change to what
  gets fed into it, not to the rule. `resolveCorner` checks one
  click against one corner's tolerance window (`CORNER_TOLERANCE_SECONDS =
  0.15`); `runRoute` replays a full click stream against a full route and
  returns `"dead"` (with the failing corner index) or `"finished"`. A
  stray click well before the next corner's window is treated as a death
  at that corner, same as arriving too late or not clicking at all.
  **Clarifies an ambiguity in the original mechanic description below**:
  there's no independent left/right choice for the player to get wrong —
  same as real Dancing Line, there's only one button, and every corner
  always requires exactly one toggle (the corridor's shape determines
  which way that toggle turns you, not the player). So the only thing the
  player can get wrong is *when* they click, which is exactly what
  `runRoute` checks. This is simpler than the `step(route, distance,
  directionChoices)` signature originally sketched in Concrete technical
  plan below, which assumed direction was a separate input — it isn't.
- **`spec/game-rule.test.ts`** — the spec's required "one rule under a
  focused automated test," importing `runRoute`/`resolveCorner` directly.
  11 cases: exact/edge/outside tolerance, missing click, late click, a
  stray early click, and an explicit "a wrong move is always possible"
  case that drops exactly one click out of a 5-corner route and asserts
  death, for every corner in turn — this is the test that backs the
  spec's "losable" requirement, not just a unit test of convenience.

One float-rounding fix worth knowing about if `resolveCorner` is touched
again: comparing `Math.abs(clickAt - cornerAt) <= tolerance` fails at the
exact boundary sometimes (e.g. `5 - 0.15` isn't exactly `4.85` in
IEEE754) — there's a `+ 1e-9` epsilon in the comparison to absorb that;
it's a rounding fix, not a gameplay looseness, don't remove it.

**Not yet built:** turning turn-times (and separately, decoration-times)
into an actual left/right/visual route shape (needed by the renderer, not
by `runRoute` — the pure rule only needs timestamps, direction is a
rendering concern), the canvas renderer/input loop, and the end-of-run
zoom-out. That's step 4 below.

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
turns, the dot goes off the corridor edge and dies. No 3D engine needed —
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
see Status above for the actual shape (`resolveCorner` + `runRoute`,
timestamp-based, no separate direction input). Matches the "no
DOM/canvas/audio dependency" goal here.

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
   **← current checkpoint. Update this file, `/clear`, reload `@PLAN.md`
   before continuing to step 4** — the mechanic is now real and tested;
   everything past this point is renderer/presentation work that consumes
   it, a clean context boundary.
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
