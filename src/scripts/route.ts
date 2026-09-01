// Turns markTurns's output (a flat list of timestamped, isTurn-flagged
// beats) into an actual drawable shape: a polyline of 90°-alternating
// segments plus positions for the non-turn beats to flash on. Pure, no
// canvas/DOM — track.ts's runRoute/resolveCorner only ever need the turn
// *timestamps*, not this shape, so this module exists purely for what the
// renderer draws (see PLAN.md's "Route shape for rendering").
//
// Direction (left vs. right at each turn) is a rendering concern only — the
// player never chooses a direction, just *when* to toggle (see track.ts) —
// so this picks a fixed, deterministic "designed" turn pattern (see
// TURN_PATTERN below) rather than anything gameplay-relevant. A strict
// ping-pong alternation (right, left, right, left, ...) turns out to look
// like one repetitive staircase once drawn at speed, not a designed map.

import type { Beat } from "./rhythm";

/** World units of forward travel per second — the only place "distance along the route" is defined. */
export const ROUTE_SPEED = 140;

export interface RoutePoint {
  /** Seconds since the route started. */
  time: number;
  x: number;
  y: number;
}

export interface Marker {
  time: number;
  x: number;
  y: number;
}

export interface RouteShape {
  /** Polyline vertices in order: the start, one per turn, then a final straight tail out to `duration`. */
  points: RoutePoint[];
  /** Same timestamps as track.ts's cornerTimes — feeds straight into runRoute/resolveCorner. */
  turnTimes: number[];
  /** Non-turn beats, positioned on the polyline, for a beat-synced visual pulse. */
  decorations: Marker[];
  /** Total route length in seconds, after clipping. */
  duration: number;
}

export interface RouteShapeOptions {
  /** Clip the route to this many seconds of the track. */
  maxDurationSeconds?: number;
  /** World units per second; defaults to ROUTE_SPEED. */
  speed?: number;
}

const DEFAULT_MAX_DURATION_SECONDS = 60;

type Vector = { x: number; y: number };

/** Rotate a heading 90°: `right` is clockwise in screen coordinates (y grows downward). */
export function rotate(heading: Vector, right: boolean): Vector {
  return right ? { x: -heading.y, y: heading.x } : { x: heading.y, y: -heading.x };
}

/**
 * A fixed repeating unit of turn directions (true = right), applied by the
 * turn's *index* in the sequence — never by its timestamp or by which walk
 * (corridor vs. player) is asking. That's required: track.ts's
 * lateralOffset calls walkTurns twice independently, once for the
 * corridor's cornerTimes and once for the player's clickTimes, and the two
 * only stay comparable if the same index always resolves to the same
 * direction. Occasional back-to-back turns in the same direction (a 180°
 * hairpin) break up what would otherwise be a uniform zigzag staircase.
 */
const TURN_PATTERN: readonly boolean[] = [true, true, false, true, false, false, true, false];

function turnDirectionForIndex(index: number): boolean {
  return TURN_PATTERN[index % TURN_PATTERN.length];
}

/**
 * Walk forward at `speed`, turning 90° (direction from `turnDirectionForIndex`,
 * by position in this sequence) at each time in `turnTimes`, out to
 * `duration`. This is the one definition of "what does a sequence of
 * turn-instants look like as a path" — shared by the corridor's own ideal
 * shape (fed beat-derived turn times below) and, in track.ts, the player's
 * actual click-driven path (fed click times instead) — so both walk
 * identically and only their *timestamps* can differ. `turnTimes` need not
 * be pre-filtered to `<= duration`; only turns up to `duration` are applied.
 */
export function walkTurns(turnTimes: number[], duration: number, speed: number = ROUTE_SPEED): RoutePoint[] {
  const points: RoutePoint[] = [{ time: 0, x: 0, y: 0 }];
  let heading: Vector = { x: 0, y: -1 }; // start moving "up" the world
  let index = 0;
  for (const t of turnTimes) {
    if (t > duration) break;
    const prev = points[points.length - 1];
    const dist = (t - prev.time) * speed;
    points.push({ time: t, x: prev.x + heading.x * dist, y: prev.y + heading.y * dist });
    heading = rotate(heading, turnDirectionForIndex(index));
    index++;
  }
  const last = points[points.length - 1];
  if (duration > last.time) {
    const dist = (duration - last.time) * speed;
    points.push({ time: duration, x: last.x + heading.x * dist, y: last.y + heading.y * dist });
  }
  return points;
}

/** Build the drawable route shape from marked beats. */
export function buildRouteShape(beats: Beat[], options: RouteShapeOptions = {}): RouteShape {
  const speed = options.speed ?? ROUTE_SPEED;
  const maxDuration = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;
  const relevant = beats.filter((b) => b.time <= maxDuration);
  const turnTimes = relevant.filter((b) => b.isTurn).map((b) => b.time);
  // A fixed clip window, not "wherever the last beat happens to fall" — a
  // real track has onset activity throughout, so callers (game.ts) are
  // responsible for passing a maxDurationSeconds that doesn't outlive the
  // actual track (e.g. min(60, trackDuration)).
  const duration = maxDuration;

  const points = walkTurns(turnTimes, duration, speed);

  const decorations: Marker[] = relevant
    .filter((b) => !b.isTurn)
    .map((b) => ({ time: b.time, ...positionAtTime(points, b.time) }));

  return { points, turnTimes, decorations, duration };
}

/**
 * Where the route is at a given time — linear interpolation between the two
 * polyline vertices straddling `time`. Shared by decoration placement above
 * and the live dot position in game.ts, so there's one definition of "where
 * is the route at time t," not two drifting copies.
 */
export function positionAtTime(points: RoutePoint[], time: number): { x: number; y: number } {
  if (points.length === 0) return { x: 0, y: 0 };
  if (time <= points[0].time) return { x: points[0].x, y: points[0].y };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (time <= b.time) {
      const span = b.time - a.time;
      const progress = span > 0 ? (time - a.time) / span : 1;
      return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
    }
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * The (unit) direction of travel at a given time — the same bracketing
 * segment `positionAtTime` would place `time` in. Used by track.ts to know
 * which axis is "sideways" (toward a wall) at the corridor's current
 * segment.
 */
export function headingAt(points: RoutePoint[], time: number): { x: number; y: number } {
  if (points.length < 2) return { x: 0, y: -1 };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (time <= b.time || i === points.length - 1) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      return length > 0 ? { x: dx / length, y: dy / length } : { x: 0, y: -1 };
    }
  }
  return { x: 0, y: -1 };
}
