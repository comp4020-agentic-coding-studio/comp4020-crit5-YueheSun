// The one core game rule: has the player's line crashed into the corridor
// wall? Pure, no DOM/canvas/audio — this is what spec/game-rule.test.ts
// exercises directly (the C5 spec's required "one rule under a focused
// automated test"), and what the live render loop calls every frame.
//
// The corridor and the player's line both walk forward at the same
// constant speed, turning 90° at a sequence of timestamps (route.ts's
// walkTurns) — the corridor turns at its beat-derived cornerTimes, the
// line turns at the player's clickTimes. "Is the line touching a wall" is
// answered the direct way: how far is the line's actual position from the
// nearest point on the corridor's actual wall geometry (the same rounded
// offset polygon game.ts draws)? Exceeding the corridor's half-width is a
// wall hit.
//
// A near-miss's residual drift is deliberately forgotten once its corner is
// behind you (round 6): each corner's tolerance is judged only against what
// happened since that corner began, not a running total from t=0 — a small
// early click at one corner and a small late click at the next shouldn't
// compound into a crash neither alone would cause. That's implemented by
// recentering the player's position at each corner's start (see
// `recenteredPosition`) rather than by anything geometric.

import { walkTurns, positionAtTime, ROUTE_SPEED, type RoutePoint } from "./route";

/** The most recent corner time at or before `time` — 0 if none yet. This is
 * when the corridor last turned, i.e. the start of whichever segment `time`
 * currently falls in. */
function segmentStart(cornerTimes: number[], time: number): number {
  let start = 0;
  for (const t of cornerTimes) {
    if (t > time) break;
    start = t;
  }
  return start;
}

/** Raw world-space line-vs-corridor difference at `time`, with no per-segment
 * correction applied — a running total from t=0. */
function rawDiff(cornerTimes: number[], clickTimes: number[], time: number, speed: number) {
  const corridor = walkTurns(cornerTimes, time, speed);
  const line = walkTurns(clickTimes, time, speed);
  const corridorPos = positionAtTime(corridor, time);
  const linePos = positionAtTime(line, time);
  return { x: linePos.x - corridorPos.x, y: linePos.y - corridorPos.y };
}

/**
 * Where the player's line actually is, recentered so that drift already
 * survived at an earlier corner doesn't linger into this one: the corridor's
 * own position at `time`, plus the *full* line-vs-corridor divergence vector
 * measured only since the current segment began (not from t=0). Both the
 * live render and hasCrashed below are built on this one point — see the
 * module comment for why the recentering exists, and PLAN.md's round-8 note
 * for why it has to be the full vector rather than a single projected axis
 * (a single axis can't tell a point near a vertex, and safely inside the
 * corridor's rounded turn, from one genuinely off in open space).
 */
function recenteredPosition(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  speed: number,
): { x: number; y: number } {
  const segStart = segmentStart(cornerTimes, time);
  const corridor = walkTurns(cornerTimes, time, speed);
  const corridorPos = positionAtTime(corridor, time);
  const cur = rawDiff(cornerTimes, clickTimes, time, speed);
  const base = rawDiff(cornerTimes, clickTimes, segStart, speed);
  return { x: corridorPos.x + (cur.x - base.x), y: corridorPos.y + (cur.y - base.y) };
}

/** Clamped distance from point `p` to segment `a`-`b` (0 if `a` === `b`). */
function pointToSegmentDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared)) : 0;
  const closestX = a.x + dx * t;
  const closestY = a.y + dy * t;
  return Math.hypot(p.x - closestX, p.y - closestY);
}

/** The wall segments a point recentered against `segStart` could actually be
 * touching: the current segment (from `segStart`'s vertex to the next one —
 * where the corridor is headed, whether or not its own clock has reached it
 * yet — the whole route is known and drawn in advance), plus the segment
 * before it and the one after, since a recentered point can end up spatially
 * on the far side of either endpoint even though `segStart`'s own segment
 * hasn't reached that vertex yet (exactly the round-8 bug: a point that's
 * only "off the *old* segment's line" by a lot can still be right next to
 * the *new* segment's line, close enough to the vertex that the old
 * segment's own endpoint clamp doesn't see it). */
function nearbySegments(points: RoutePoint[], segStart: number): [RoutePoint, RoutePoint][] {
  let j = 0;
  while (j < points.length - 1 && points[j].time < segStart) j++;
  const segments: [RoutePoint, RoutePoint][] = [[points[j], points[Math.min(j + 1, points.length - 1)]]];
  if (j > 0) segments.push([points[j - 1], points[j]]);
  if (j + 2 < points.length) segments.push([points[j + 1], points[j + 2]]);
  return segments;
}

/**
 * Where the player's line should actually be drawn — see
 * `recenteredPosition`. Keeping the render and the crash check built on the
 * exact same point (not a separately-asserted "matches" claim) is the whole
 * fix for the round-8 bug: see PLAN.md.
 */
export function linePosition(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  speed: number = ROUTE_SPEED,
): { x: number; y: number } {
  return recenteredPosition(cornerTimes, clickTimes, time, speed);
}

/** Has the line physically touched a wall — i.e. is its actual (recentered)
 * position farther than `halfWidth` from every nearby stretch of the
 * corridor's own polyline? The whole route (past and upcoming corners alike)
 * is known in advance and drawn in advance, so "nearby" means the current
 * segment plus its neighbors on both sides (see `nearbySegments`) — not just
 * whichever segment the corridor's own clock happens to be on. */
export function hasCrashed(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  halfWidth: number,
  speed: number = ROUTE_SPEED,
): boolean {
  const segStart = segmentStart(cornerTimes, time);
  const corridor = walkTurns(cornerTimes, Math.max(time, ...cornerTimes, 0) + 1, speed);
  const point = recenteredPosition(cornerTimes, clickTimes, time, speed);
  const distances = nearbySegments(corridor, segStart).map(([a, b]) => pointToSegmentDistance(point, a, b));
  return Math.min(...distances) > halfWidth;
}
