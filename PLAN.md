# PLAN.md — working plan for C5 (a rhythm-line game)

Not the spec (see `spec/README.md`) and not `PROCESS.md`. This is the living
build plan: reasoning behind decisions, current state, and next steps for
whoever (agent or me) picks this up next. Update it at phase boundaries, then
`/clear` and reload with `@PLAN.md`, per `CLAUDE.md`.

## Status (renderer + wall collision + designed turns + true corner fillets + stable camera + on-corridor progress markers + end-of-run pull-back all built; run stats next)

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

- **`src/scripts/track.ts`** — the one core rule. Originally rewritten
  after a playtest correction (the first version, `resolveCorner`/
  `runRoute`, compared click *timestamps* to corner *timestamps* within a
  fixed tolerance window, with the dot always rendered on the ideal
  precomputed corridor regardless of how accurate clicks were — matched
  none of "off the corridor = death" as scoped below). Made genuinely
  spatial via `lateralOffset`/`hasCrashed`, then **rewritten again in round
  8** (see that section below) to test real geometric distance to the
  corridor's actual wall polyline instead of a single projected axis —
  `lateralOffset` is gone; `hasCrashed(cornerTimes, clickTimes, time,
  halfWidth, speed)` and `linePosition(cornerTimes, clickTimes, time,
  speed)` are the current exports, both built on the same recentered 2D
  position. `CORRIDOR_HALF_WIDTH` (in `game.ts`) remains the *only*
  difficulty/visual knob, since crossing it is what a wall hit literally
  means.
- **`spec/game-rule.test.ts`** — the spec's required "one rule under a
  focused automated test," importing `hasCrashed` directly (the
  now-removed `lateralOffset` was dropped from this file in round 8).
  Cases: perfect clicks never crash; an early or late click within the
  divergence window (`halfWidth / speed`) survives; a click further off
  than that crashes before the corner even arrives (the "immediate failure
  on a mistimed click" behaviour); a missed click drifts into a crash
  shortly after the corridor's own turn; a stray click on a straight
  stretch crashes; an explicit "a wrong move is always possible" case that
  drops exactly one click out of a 5-corner route and asserts every one of
  them eventually crashes; and (round 8) a case reproducing the
  reported false-positive shape directly — a point still close to the
  *upcoming* wall right after an early click must not crash just because
  it's far from the *old* wall's line.

**Not yet built:** run stats (time survived/finished, distance, click
count) on the end-of-run screen — see round 9 below, the only remaining
piece of step 6.3's original scope. The beat-synced pulse, the
20/40/60/80% progress markers (now on-corridor, not a HUD bar), and the
end-of-run camera pull-back/full-path reveal are all built — see "Mechanic"
below for the renderer's current shape and round 9 for the latest three
changes.

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
  way. **Superseded by round 6 below:** the line is no longer *drawn* at
  this raw position — `track.ts`'s `linePosition` re-centers it onto the
  corridor at the start of every segment, so only within-segment drift is
  ever visible or judged.
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

**Round-3 feel requests (corridor width, corner style, map variety):**
alongside the timing fix above, two separate complaints came out of the
same playtest:

- *"The corridor is too wide and the corners look too rounded."*
  `CORRIDOR_HALF_WIDTH` went 34→20 (a first pass, before round-3's
  timing-driven 20→12 above — the two changes landed for different
  reasons but compound). Corner rendering switched from
  `ctx.lineJoin = "round"` to `"miter"` with `ctx.miterLimit = 2`
  (`game.ts`) — safe as a hard miter because every corridor segment
  meets the next at exactly 90°, so a miter never spikes the way it
  could at an arbitrary angle. **Reversed in round 5 below** — the
  miter turned out to visually overshoot the real hitbox at every
  corner, and playtest preferred correctness there over the sharper
  look.
- *"The map should look actually designed, not a repetitive
  alternating left-right zigzag."* `route.ts`'s `walkTurns` picked
  direction by flipping a `turnRight` boolean every turn — a strict
  ping-pong that reads as one uniform staircase once drawn at speed.
  Replaced with a fixed repeating `TURN_PATTERN` (`[true, true, false,
  true, false, false, true, false]`, `true` = right) indexed by the
  turn's *position in the sequence* via `turnDirectionForIndex(index)`,
  giving occasional back-to-back turns in the same direction (hairpins)
  instead of pure alternation. The index-not-timestamp rule is load-
  bearing: `lateralOffset` calls `walkTurns` twice independently (once
  for the corridor's `cornerTimes`, once for the player's own
  `clickTimes`), and the two walks only stay comparable if the same
  index always resolves to the same direction regardless of which
  walk or what the actual timestamp is.

## Locked mechanic/UI invariants (round 4)

Round-3's tolerance read as too tight in play (the 12px corridor / 40ms
click slack felt like "no room to be wrong"). Widened `CORRIDOR_HALF_WIDTH`
12→24 in `game.ts` (lag 40ms→80ms, still under the ~100ms simultaneity
threshold round-3 established). Alongside that fix, two things got
confirmed as deliberate design, not incidental — worth locking in here so a
later tuning pass doesn't undo them without an explicit ask:

1. **Judgment logic is purely spatial.** `hasCrashed` (`track.ts`) never
   compares click timestamps to corner timestamps — a click only ever
   changes when the player's own line turns (`walkTurns(clickTimes, …)`);
   death is exclusively "has that line's actual position drifted farther
   than `CORRIDOR_HALF_WIDTH` from the corridor's own wall geometry."
   (Round 8 replaced the original single-projected-axis version of this
   check with real distance to the corridor's polyline — see that section
   below; the *principle* that there's one spatial number and no separate
   timing check predates and survives that rewrite unchanged.)
   `CORRIDOR_HALF_WIDTH` is intentionally the single knob for both
   the drawn corridor's width and a click's timing slack (tolerance =
   `CORRIDOR_HALF_WIDTH / ROUTE_SPEED`) — there is no second, independent
   timing-tolerance constant anywhere in the code, and none should be
   reintroduced; widening/narrowing the corridor *is* widening/narrowing
   the forgiveness, by construction, not two things to keep in sync by
   hand.
2. **The live viewport deliberately shows only a short stretch of
   corridor around the dot** — no zoom-out, no extended lookahead. This
   falls out for free from a camera fixed on the dot + constant
   `ROUTE_SPEED` + a normal screen size (`game.ts`'s `draw()` draws the
   *entire* route every frame, but only whatever falls inside the current
   screen translate is ever visible) — not a separate clipping mechanism,
   and not something to add one for. The point: a player must react to a
   freshly-revealed turn quickly, which is what makes the self-teaching/
   10-second-legibility requirement (see Alignment below) actually true in
   play, not just in theory. Don't slow the world down or widen the render
   lookahead to make more track visible at once — that trades away the
   "quick judgment on reveal" difficulty this game is testing.

## Round 5: corridor corner rendering vs. the real hitbox

Playtest report: "sometimes it looks like the line hasn't hit the wall,
but it still registers as a failure." Investigated as analysis first
(not a tuning-knob reflex — CLAUDE.md's "check whether the design is
wrong before reaching for a tuning knob"), by checking the actual math
against ground truth rather than guessing:

- **Ruled out:** the earlier "click doesn't take effect until the next
  turn point" bug (round-3's original `resolveCorner`/`runRoute` model)
  reappearing. Grepped for any deferred/queued-click code path — none
  exists; `walkTurns` applies every click at its own exact timestamp,
  confirmed by reading it directly.
- **Ruled out:** a logic bug in `lateralOffset`/`hasCrashed` themselves.
  Numerically compared their output against a from-scratch "true
  distance to nearest point on the corridor polyline" calculation across
  early/late/missed clicks and hairpins — exact agreement in every case.
- **Found, but not the cause here:** `turnDirectionForIndex` (`route.ts`)
  picks direction by a click's *position in the array*, not by which
  corridor corner it was meant to answer. Missing one click permanently
  shifts every later click's direction reference by one `TURN_PATTERN`
  slot — a real direction desync, not just a timing slip. Currently
  unreachable in practice: a missed click already crashes the run within
  `CORRIDOR_HALF_WIDTH / ROUTE_SPEED` (≈80ms), before a later click's
  wrong index can ever matter. Left as-is — flagging here so a future
  change to the crash-recovery behaviour doesn't unknowingly wake this
  up.
- **Actual cause:** `game.ts`'s corridor stroke used `lineJoin = "miter"`
  (round-3, for a sharper look). For a 90° turn, a full miter's outer tip
  sits `CORRIDOR_HALF_WIDTH × √2` from the vertex — at `CORRIDOR_HALF_WIDTH
  = 24` that's ≈33.9 vs. 24, a ~10-world-unit (~33ms at `ROUTE_SPEED`)
  overshoot *only* at the outside of every turn. `hasCrashed` has no
  knowledge of this bulge — it's still plain perpendicular distance to the
  corridor's current segment — so right at a turn the drawn wall reached
  further out than the line actually being checked. That's exactly "looks
  fine, registers dead."

Tried `miterLimit` low enough to force a bevel fallback (a flat corner
chamfer, smaller overshoot than a full miter) as a middle ground that
would keep round-3's "not too rounded" look. Playtest verdict: go back to
full round joins instead — `lineJoin = "round"` makes the rendered
boundary a literal arc of radius `CORRIDOR_HALF_WIDTH` around the vertex,
which matches `hasCrashed`'s real hitbox exactly, zero overshoot. This
knowingly re-introduces the "too rounded" look round-3 moved away from;
between the two round-3/round-5 complaints, matching the real hitbox won
out over corner sharpness. If corner sharpness comes up again, the bevel
`miterLimit` (tested, not shipped) is the documented middle ground, not a
fresh idea to reinvent — but don't reach for miter again without also
addressing this overshoot.

## Round 6: a survived near-miss shouldn't tighten the next turn

Playtest report: "if the previous turn was an edge-hugging near-miss, the
path in between hugs the wall, making the *next* turn much more likely to
crash — even with a good click there." Player's own hypothesis: Dancing
Line re-centers the line onto the corridor after each turn, so a past
near-miss can't eat into a future turn's tolerance. Confirmed this by
tracing `lateralOffset`'s actual math, not just by feel:

- `lateralOffset` computed the corridor's and the line's positions as one
  continuous walk from `t=0` (`walkTurns`), took their raw world-space
  difference, and projected it onto the corridor's *current* heading.
  Once both are moving in the same direction, that raw difference is
  **constant** — it neither grows nor shrinks — until the next turn.
  Because every turn is exactly 90°, "forward along the old segment"
  always becomes "sideways on the new segment," so *any* leftover timing
  error from turn N carried forward as a **permanent, undiminishing**
  sideways offset going into turn N+1 — a perfectly-timed click at N+1
  didn't reduce it, and a same-direction (hairpin) turn N+1 stacked its
  own fresh error on top additively.
- Worked example (`ROUTE_SPEED=300`, `CORRIDOR_HALF_WIDTH=24`): an early
  click leaving an 18-unit residual (survivable alone) followed by an
  independently-survivable 6-unit-late click at the next corner summed to
  24+ under the old model and crashed — even though neither click was
  individually too far off. Confirmed as a real, provable bug, not a
  tuning/feel issue, and confirmed the player's Dancing-Line hypothesis is
  the right shape of fix.

**Fix — per-segment baseline reset (`track.ts`):** `lateralOffset` now
finds `segmentStart`, the corridor's most recent turn at or before `time`
(0 if none yet), and subtracts the same raw line-vs-corridor difference
evaluated *at that instant* before projecting onto the lateral axis. This
is exactly zero the moment a segment begins — discarding whatever
residual came before — and grows only from what happens within the
current segment. `hasCrashed` is unchanged (still `abs(lateralOffset(...))
> halfWidth`); only what "offset" means shifted, from "total drift since
t=0" to "drift since this turn." Verified against every existing
`spec/game-rule.test.ts` case (all single-corner, or all-but-one-exact
scenarios where the baseline is always zero anyway — unaffected) plus a
new regression case built from the worked example above, which used to
crash and now survives.

**Rendering re-centers too, via a new `track.ts` export,
`linePosition`:** the drawn dot is now `corridorPos(time) +
lateralOffset(...) * lateralAxis(time)` — always tracking the corridor's
own forward progress exactly (both move at identical constant speed, so
there's never a meaningful ahead/behind to show), deviating only by the
same sideways amount the crash check uses. `game.ts`'s dot and trail both
switched from raw `positionAtTime(walkTurns(clickTimes, t), t)` to this.
Keeping render and judgment as one source of truth is the same principle
round 5 above established the hard way. The dot visibly **snaps** back to
centerline the instant each turn completes, rather than carrying visible
drift across it — this is deliberate, not a placeholder (see below).

**Line width, and a tried/reverted smoothing tween:** the player's line
also gained real rendered width (`game.ts`'s `LINE_WIDTH = 14`, drawn as a
connected round-joined ribbon rather than a chain of small dots) after a
playtest report that the centerline snap read as a jarring
jerk/shake. The first attempt at fixing that *feel* complaint added a
`RECENTER_SECONDS` eased blend to `linePosition`, sliding from the
previous segment's own trailing offset to the new segment's. This was
reverted: because a 90° turn rotates the whole coordinate frame, the old
segment's sideways axis and the new segment's sideways axis are
*perpendicular*, so a straight-line blend between offsets measured on
each one drew a visible diagonal cut across the inside of every
corner — the reported "45° angle," which made the inner corner
noticeably easier to clip. It served no gameplay purpose (confirmed by
re-deriving the axis relationship by hand) and was removed outright
rather than patched, per this file's own "check whether the design is
wrong before reaching for a tuning knob" guidance — `linePosition` is
back to the plain instantaneous formula above. The line's new width is
what's left addressing the original feel complaint; re-test that in the
browser before deciding whether the snap still needs a smoothing pass, and
if so, design it so the two segments' axes are never blended directly
(e.g. easing the scalar `lateralOffset` value on a single, always-current
axis, not lerping two perpendicular world-space points).

## Round 7: rounding the corridor's *inner* corner (done, corrected)

Two requests from the same playtest message: (1) "since the line now has
width, increase the corridor/collision tolerance a bit more" — done,
`CORRIDOR_HALF_WIDTH` 24→28 (committed, see comment in `game.ts` for why:
the line's own rendered edge was visually poking past the wall before the
centerline check actually crashed). (2) "round the inner corner too" —
**now done and confirmed live** (see below); an earlier pass claimed this
was already correct and was wrong — see the corrected geometry below and
`process-notes.md`'s "A 'confirmed' fix was wrong" entry for how that was
caught.

**Rejected attempt:** filling a disc of radius `CORRIDOR_HALF_WIDTH` at
every interior `route.points` vertex, on top of the existing centerline
stroke. Typechecked and played fine, but the user explicitly rejected the
approach itself, not just the look: "I don't need a filled disc at the
turn vertices... the inner corner of the path itself should have a rounded
turn radius — like a border-radius applied directly to the wall geometry
at the corner, not a circular shape stamped on top of the vertex." Reverted
out of `game.ts` (a stamped shape isn't the wall's own outline, regardless
of how correct its radius is) — left only as a code comment pointing here.

**The actual fix needs the corridor drawn as a filled offset polygon, not
a stroked centerline.** Worked out the geometry by hand so the next pass
doesn't have to re-derive it — **first pass below turned out to be
wrong about the inner side specifically; corrected further down.**

- At every interior vertex `V`, the corridor has two boundary lines run
  past it: the incoming segment's offset line (parallel to the incoming
  heading, at perpendicular distance `h = CORRIDOR_HALF_WIDTH`, on a given
  side) and the outgoing segment's offset line (same, for the outgoing
  heading). Because *both* offset lines are literally defined as "distance
  `h` from a line passing through `V`," **both are always at exact
  perpendicular distance `h` from `V` itself** — regardless of which side
  (left/right) or which way the corridor turns there.
- The *sharp* corner these two lines naturally form (where they cross, if
  extended) sits at distance `h√2` from `V`, not `h` — on both sides,
  arithmetically.
- **Where the first pass went wrong:** it assumed that because both
  offset lines sit at distance `h` from `V`, an arc of radius `h` centered
  on `V` is the right fillet on *both* sides. That's only true on the
  **convex** (outer) side of a turn. On the **concave** (inner) side, the
  true hitbox — the actual Minkowski sum of the route polyline with a
  radius-`h` disc, which is what `hasCrashed` checks against — has a
  **sharp** corner at the miter point `M = V + h·(lateral_in+lateral_out)`,
  not a circular arc around `V`: from that side's quadrant, the nearest
  point on the route polyline is always on one of the two straight
  segments, never `V` itself. So on the inner side, the sharp miter is
  already geometrically correct, and "rounding" it is a cosmetic choice
  (asked for anyway, to visually match the outer side — see below), not a
  hitbox-accuracy fix.
- Worse, reusing the V-centered arc construction on the inner side doesn't
  just look wrong, it's **invisible**: the straight boundary segments
  immediately before and after that vertex still pass through `M`
  regardless of the arc drawn nearby, so the closed path develops a small
  self-intersecting loop right at the corner. `ctx.fill()`'s default
  nonzero winding rule re-fills that loop's area, exactly canceling the
  arc's visual effect — the corner renders exactly as sharp as a plain
  miter despite the arc code running. This — not a missing code path — is
  why the original implementation of this round looked completely
  unrounded on the inner side. Confirmed by an isolated, faithful
  reproduction of the exact production code (copy-pasted verbatim into a
  standalone Playwright/Firefox test page) plus a pixel-sampled diagonal
  scan across the corner showing the fill uncut all the way to `M`.
- **Correct concave-side fillet (radius `h`, per the user's cosmetic
  request to match the outer side):** center the arc further out, at
  `center = M + h·(lateral_in+lateral_out)`, tangent to the two offset
  lines *beyond* `M` at `M + h·lateral_out` (on the incoming line) and
  `M + h·lateral_in` (on the outgoing line) — using the 90°-turn-specific
  fact that `lateral_out` is parallel to `heading_in` and `lateral_in` is
  parallel to `heading_out`, so these tangent points really do lie further
  along the same two offset lines, past `M`. Which side is concave at a
  given vertex flips with the turn's own direction, so it's determined
  generically via `crossZ(heading_in, heading_out) > 0` rather than by
  threading `TURN_PATTERN`'s direction data into the renderer.

**Implemented as corrected:** `game.ts` has a `filletVertex` helper that
branches on convex vs. concave per boundary-side per-vertex (`crossZ`
test above) and applies the matching construction — the original
V-centered arc on the convex side (unchanged from the first pass), the
new M-relative arc on the concave side. `buildCorridorOutline` is
otherwise structurally the same as the first pass described above (one
closed `Path2D`, right boundary start→end, round end cap, left boundary
end→start, round start cap, filled once with `ctx.fill()`).

**Verified in the browser, not just typechecked, and not just claimed —
this is the second time this round was "confirmed" and the first claim
was wrong, so the bar here is a precise zoomed screenshot, not a
glance.** `pnpm check` green (53 tests, unchanged — rendering-only, no
tested module touched). Live-verified via three escalating throwaway
Playwright/Firefox scripts: (1) an isolated reproduction of the *original
buggy* code, pixel-scanned to prove the self-intersection/winding
cancellation described above; (2) an isolated test of the *new* formula
alone; (3) a faithful reproduction of the *entire corrected* production
code rendering both a right-turn and a left-turn test route, zoomed crops
of each confirming clean, symmetric rounding with no artifacts. Finally,
against the real running dev server itself: a zoomed crop of the first
live turn shows the black playable area's boundary curving smoothly on
the concave/inner side, at a radius visually matching the outer arc, with
no leftover sharp point or self-intersection artifact.

**Lesson for next time (worth keeping as a standing habit, not just a
note about this bug):** a convex and a concave corner of the same turn
are not the same problem wearing a mirror image — the concave side's
*correct*, hitbox-accurate shape is already sharp, so "round it too" is
cosmetic there in a way it isn't on the convex side, and copying one
side's formula onto the other produced code that ran without error and
still did nothing visible. The failure mode (nonzero-winding-rule
self-cancellation) doesn't throw or fail a type check — the only way it
was caught was a pixel-level check of the actual rendered fill, not a
glance at a screenshot or a read of the code.

## Round 8: hasCrashed becomes real geometric distance-to-wall (supersedes the single-axis model)

Bug report, with a screenshot (`image.png`): a crash registered while the
line was visibly still inside the corridor, nowhere near a wall, near a
rounded turn. The user's explicit ask had two parts: (1) go back to the
simpler symmetric fillet in `game.ts` (done above, see the round-8 note in
`filletVertex`'s comment), and (2) redesign the collision rule itself so
"crashed" means "the line's actual position is far from the actual wall
geometry," not an abstract offset-from-centerline number that doesn't know
what the wall looks like.

**Root cause, found empirically (a forward-scanning probe against the real
code, not a read-through):** the old `lateralOffset` picked *one* axis —
perpendicular to the corridor's *current* heading — and projected the
recentered line-vs-corridor difference onto only that axis, unclamped and
extended to infinity, reset to zero at each corner instant. Near a vertex
this is blind to the *other* segment meeting there: a point can be safely
inside the corridor's rounded turn (close to the *upcoming* wall) while
still reading as "far off" the old segment's line alone, because the old
axis has no notion of "this is close to a different wall" at all — it only
ever measured distance to one infinite line. Concretely: for an early click
before the corridor's own turn (so the corridor hadn't turned yet and the
recentering baseline was still 0), the old model would flag a crash the
moment the *old*-axis offset exceeded `CORRIDOR_HALF_WIDTH`, even when the
true clamped distance to the *upcoming* wall segment was much smaller — the
exact shape of the reported bug.

**Fix (`src/scripts/track.ts`, fully rewritten):**
- `recenteredPosition` keeps the round-6 per-corner "forgetting" idea (reset
  the baseline at `segmentStart`, the corridor's most recent turn at or
  before `time`) but now returns the **full 2D point**, not a single
  projected scalar. `linePosition` is now a thin wrapper around this — same
  one-source-of-truth principle round 6 established, just no longer losing
  a dimension.
- `hasCrashed` computes real clamped point-to-segment distance
  (`pointToSegmentDistance`) from that point to the **nearby wall
  segments** — not just whichever segment the corridor's own clock happens
  to be on. `nearbySegments(points, segStart)` returns the segment starting
  at `segStart`'s vertex, the one before it (if any), and the one after (if
  any). The "one after" is the part that actually fixes the reported bug:
  the whole route is known and drawn in advance, so the upcoming wall is
  real geometry a spatially-early point can already be touching, even
  before the corridor's own simulated clock reaches that vertex. Crash =
  the minimum of those 2–3 segment distances exceeds `halfWidth`.
- This makes the crash check and the drawn wall the same geometric fact for
  the first time: "distance to the route polyline ≤ h" is exactly what a
  round-jointed offset-polygon (game.ts's fillet) draws, on the convex side
  of every turn. Confirmed **not fully exact on the concave (inner) side**:
  re-derived by hand and checked numerically (see `filletVertex`'s comment
  in `game.ts`) that the true polyline-distance boundary there is the
  *sharp* corner round 7 originally found (min-distance to each straight
  segment, meeting past `V`), not a circle centered on `V`. The plain
  symmetric arc now drawn there (per this round's ask to simplify) is a
  strictly more conservative (smaller) safe area than the real hitbox on
  that side only — verified with a concrete point that's outside the arc's
  radius but well within `h` of the nearer real wall. This asymmetry can
  only make an inner-corner strip look blocked when it's technically safe,
  never the reverse ("looks safe, still crashes") — the direction that
  actually mattered for the reported bug — so it was left as-is rather than
  resurrecting round 7's exact concave construction.
- `lateralOffset` as an exported single-axis function is gone; nothing else
  referenced it (confirmed by grep, and by `pnpm check`'s typecheck).

**Verification:**
- `spec/game-rule.test.ts` rewritten: every existing scenario's expected
  boolean outcome preserved (hand-verified before the rewrite, confirmed by
  the suite passing after), plus one new case reproducing the reported
  shape directly (a point close to the *upcoming* wall right after an early
  click, still well inside `halfWidth` of the real nearest segment). `pnpm
  check`: 54/54 tests, clean typecheck/build.
- Re-ran a throwaway forward-scanning probe (same pattern as the original
  diagnosis, deleted after use) against the new `hasCrashed` at real-game
  scale (`ROUTE_SPEED=300`, `CORRIDOR_HALF_WIDTH=28`): a 100ms-early click
  (just past the ~93ms window) now crashes right at the true geometric
  boundary (distance ≈28.05, i.e. the window is respected almost exactly,
  not early); a late click crashes at ≈93.5ms after the corner (matches the
  window); a two-close-corners scenario with an 80ms-early click at the
  first survives with no spurious crash anywhere in a full forward scan.
  No false positive found anywhere in these scans, unlike before the fix.
- Not independently re-verified live in-browser in this sandbox (headless
  Chromium/Firefox both fail to launch here — missing system shared
  libraries, not fixed as part of this task, same limitation noted in round
  7's Playwright work). **Ask the user to check this themselves** via the
  running dev server, near a turn, before treating this as fully closed —
  this repo's own "the rendered page is the truth" rule applies especially
  here since the reported bug was itself a visual/geometric mismatch.
- Also corrected stale comments describing the old single-axis model:
  `game.ts`'s module header (`linePosition`'s "offset sideways" framing),
  `route.ts`'s `TURN_PATTERN` comment (referenced the now-removed
  `lateralOffset` by name), and the round-4 "Locked mechanic/UI invariants"
  section below (still described `hasCrashed` as projecting onto one axis).

## Round 9: camera-shake fix, progress percentage labels, end-of-run pull-back

Three changes, all confined to `game.ts` (rendering only — `pnpm check`
stayed at 54/54 throughout, no touched module has a test).

**1. Camera-shake fix.** Bug report: "the camera/viewport shakes
violently when turning." Traced (not guessed) to `track.ts`'s
`recenteredPosition`: it snaps the drawn dot exactly onto the corridor
centerline at *every* corner the corridor itself turns at, not just ones
the player mistimes — confirmed deliberate in round 6, for the dot's own
render/hitbox fairness. But the camera was bound 1:1 to that same point
(`ctx.translate(width/2 - dot.x, ...)`), so it snapped too, at every
corner in the whole route (every ~1.2s on average, per the onset density
in Status above) — that's the "violent shake." Fix: the camera now lerps
toward the dot with a plain exponential filter (`CAMERA_SMOOTHING_SECONDS
= 0.15`) instead of equalling it; `cameraX`/`cameraY` are new state in
`startGame`, reset to `NaN` (meaning "snap on next frame") on `reset()`.
This is *not* a repeat of round 6's reverted tween: that one broke because
it blended two **perpendicular** lateral axes into the position that also
fed the hitbox and the dot's own render, producing a fake diagonal path.
This lerp only ever touches where the camera is centered — the dot,
trail, and `hasCrashed` all still use the exact, unsmoothed point, so it
can't affect fairness or reintroduce that bug.

**2. Progress markers as labels beside the corridor.** User's ask:
markers belong on the track itself, not a separate HUD bar. The old
top-of-screen bar + percentage text (screen-space, drawn after
`ctx.restore()`) is gone entirely. First attempt drew a bright band
spanning the corridor's full width at each fraction; the user then
corrected that — nothing should be drawn on the playable surface
itself, only a label outside it. Current shape: `progressMarkers`
(computed once, alongside `corridorOutline`, from `route.points` via
`positionAtTime`/`headingAt` at 20/40/60/80% of `route.duration`) each
store a label position offset outward from the corridor edge by
`CORRIDOR_HALF_WIDTH + PROGRESS_LABEL_MARGIN` (36) along a fixed lateral
side. Each frame, `draw()` renders `"20%"`/`"40%"`/etc. there — upright
regardless of the corridor's heading at that point, since world space
here is only ever translated/scaled, never rotated — dim before the dot
reaches them, brightening permanently once passed. After a follow-up
("too small, make them more prominent") the font went from 16px to bold
34px monospace with a dark stroke (`lineWidth 6`, `rgba(0,0,0,0.65)`)
drawn behind the fill, so the label pops against both the dark
background and the corridor's own gray at a glance. World-space, so
they zoom with everything else during the round-9-3 pull-back below,
and scroll into view exactly like the rest of the corridor (no separate
reveal logic).

**3. End-of-run camera pull-back — finish only** (the last open piece of
"The idea, as given" / Scope item 4 / step 6.3, deferred since round 4).
First built to apply on either `"dead"` or `"finished"`, matching the
idea's original "camera pulls back to a top-down view of the whole path
traveled" reading it as covering a loss too — the user then corrected
that: a death should just freeze in place (dot turns red, screen stops)
like it did before this round, no pull-back, no full-path reveal, no
title. Current shape: on a finish, `checkState`'s `enterTerminal`
snapshots two things once: `fullTrail` (the *entire* traveled path from
t=0 to the final instant, resampled fresh via `linePosition` at a fixed
1/60s step — not the existing live `trail`, which is capped to a few
seconds for the fading-tail look and was never meant to hold a whole
run) and `zoomTarget` (a `fitCamera` bounding-box fit of `fullTrail`,
padded by `CORRIDOR_HALF_WIDTH * 3` so the corridor's own width doesn't
clip at the screen edge, capped at 1x so a very short run never zooms
*in*). `draw()`'s per-frame camera lerp (same mechanism as fix 1) then
chases `zoomTarget` instead of the live dot, using a slower
`ZOOM_SMOOTHING_SECONDS = 0.6` so the pull-back reads as a deliberate
camera move rather than another snap. On a death, none of this runs —
`enterTerminal` skips the snapshot entirely, and `draw()`'s camera
target falls back to the dot at 1x with the normal
`CAMERA_SMOOTHING_SECONDS`, same as live gameplay; since `elapsed` stops
advancing once `terminal` is set, the dot's position goes static and the
camera simply stops moving where it already was, rather than tweening
anywhere. Trail render and the "SUCCESS" title follow the same
finish-only split: only `terminal === "finished"` switches to a single
solid stroke of `fullTrail` and shows the fixed screen-space title
(drawn after `ctx.restore()`, so it doesn't pan/zoom with anything under
it); `"dead"` keeps drawing the same capped, fading `trail` it had at
the moment it died (the render loop stops pushing to `trail` once
`terminal` is set, so it just holds still) and shows no title. Clicking
after either terminal state restarts the run (`onInput` calls `reset()`
whenever `terminal` is set) — that was already wired up before this
round, not something added for this correction.

**Not built:** run stats (time survived/finished, distance covered, click
count) on the end screen — the pull-back and full-path reveal were the
explicit ask this round; stats are the remaining piece of step 6.3's
original scope, next up if wanted.

**Ask the user to check this live** before treating it as closed — same
sandbox limitation as rounds 7–8 (no headless browser here), and this is
exactly the kind of feel/timing work `CLAUDE.md` flags for a human to
actually look at rather than trust from the diff: is the shake actually
gone, does 0.15s follow feel laggy, do the percentage labels read
clearly (size/contrast) at both marking viewports, does the 0.6s
pull-back on a finish land somewhere that actually shows the whole run,
does a death actually freeze in place with no camera movement at all,
and does clicking after either outcome cleanly restart the run.

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

1. ~~Move music into `src/`~~ — done.
2. ~~Write `rhythm.ts` + sanity-check it~~ — done, see Status above.
3. ~~Write the pure rule + its spec test~~ — done (`track.ts`'s
   `lateralOffset`/`hasCrashed`, see "Mechanic: real wall collision").
4. ~~Turn onset times into a drawable route shape and build the canvas
   renderer + input loop~~ — done (`route.ts`'s `walkTurns`/
   `buildRouteShape`, `game.ts`'s render/input loop). Fading trail
   (Scope item 8) is built (`game.ts`'s `TRAIL_LENGTH`). **Beat-synced
   pulse (Scope item 7) is not** — `route.ts`'s `buildRouteShape` already
   computes `decorations: Marker[]` for every non-turn beat, but
   `game.ts`'s `draw()` never reads `route.decorations` at all right now
   — folded into step 5 below since it's the same "polish the live view"
   pass.
5. ~~Playtest round-3 fixes~~ — done: `minStartSeconds` removed (turns
   allowed from t=0), corridor narrowed + sharpened
   (`CORRIDOR_HALF_WIDTH` 34→20→12, miter corners), designed turn
   pattern (`TURN_PATTERN` replacing strict alternation), and the
   click-to-death timing lag tightened (`ROUTE_SPEED` 140→300) — see
   Status above for all four.
6. **Enrich mechanics + polish the UI** (user's stated next direction,
   scoped to the still-open MVP items rather than anything new):
   1. ~~Render the beat-synced pulse from `route.decorations`~~ — done,
      `game.ts`'s `draw()` reads `route.decorations` (faint always-on dot
      + brightening ring as the player passes each one).
   2. ~~Progress markers~~ — **redesigned in round 9** (see below): moved
      off the screen-space HUD bar entirely, into large percentage labels
      beside the corridor at 20/40/60/80%.
   3. **End-of-run camera pull-back — done in round 9** (see below); run
      stats (time survived/finished, distance, click count) are the one
      piece of the original step 6.3 scope still not built.
7. Playtest cold at both marking viewports; capture the one change that
   comes out of that (not out of re-reading the code) for `PROCESS.md`.

**← current checkpoint.** Round 9 (camera-shake fix, progress percentage
labels, end-of-run pull-back — see below) is committed, `pnpm check`
green (54 tests, unchanged — all three changes are rendering-only). **Not
yet confirmed live in the browser** — same sandbox limitation as rounds
7–8 (headless Chromium/Firefox can't launch here); ask the user to check
the dev server before treating this as fully closed. Next: the run-stats
half of step 6.3, then step 7 (cold playtest).

## Next-session work (requested, not started): gem rewards + death sound

Two more items the user wants built in a future session, after step 6
above is checked off — noted here now, deliberately not started this
session:

1. **Branching gem-reward mechanic.** Occasionally the route offers two
   parallel paths forward instead of one: an easy path (straight, with
   the normal decorative/non-turn beat markers on it) and a harder path
   that turns those *same* decoration beats into actual required turn
   points, with a gem placed on it. Taking the harder path and surviving
   it collects the gem; each collected gem adds points shown on the
   end-of-run results screen (step 6.3's summary screen, once built).
   **Explicit constraint from the request:** the choice itself must stay
   simple — the line never stops moving, so a player has only a couple of
   turns to react to a branch appearing at all before it's decided by
   default. This is a genuinely new mechanic (two co-existing corridors
   instead of one), not a variation on the existing single-corridor
   model — needs real design thought before implementation: how a branch
   is chosen/generated from the beat data, how `route.ts`'s single
   `points`/`turnTimes` shape extends to "two shapes for a stretch," and
   how `track.ts`'s collision rule generalizes to "which of two corridors
   is the player currently closest to" without breaking the existing
   one-rule spec test. Don't start coding from this paragraph alone —
   design it properly (probably its own PLAN.md section) before touching
   `route.ts`/`track.ts`.
2. **Impact sound effect on death.** Play a short sound the instant
   `terminal` becomes `"dead"` in `game.ts`. Simple, additive, no design
   questions — just needs an actual sound asset and a play() call
   alongside the existing `audio.pause()` in `checkState()`.
