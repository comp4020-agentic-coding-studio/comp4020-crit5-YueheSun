import { describe, expect, it } from "vitest";
import { hasCrashed, lateralOffset } from "../src/scripts/track";

// The C5 spec's required "one rule under a focused automated test": has the
// player's line drifted sideways into the corridor wall? This is the whole
// game — miss a turn and the line drifts off the corridor and crashes, so a
// wrong move being possible (the spec's "losable" requirement) and this
// rule are the same fact, tested directly.
//
// Round numbers throughout: speed 10, half-width 2, so the divergence
// window (how long a mistimed click takes to reach the wall) is a clean
// 0.2s, and corner gaps of 1s leave plenty of room between events.
const SPEED = 10;
const HALF_WIDTH = 2;
const WINDOW = HALF_WIDTH / SPEED; // 0.2s

describe("lateralOffset / hasCrashed", () => {
  it("stays on the centerline (never crashes) when every click matches its corner exactly", () => {
    const corners = [1, 2.5, 4];
    for (const t of [0, 1, 2, 2.5, 4, 6]) {
      expect(lateralOffset(corners, corners, t, SPEED)).toBeCloseTo(0);
      expect(hasCrashed(corners, corners, t, HALF_WIDTH, SPEED)).toBe(false);
    }
  });

  it("survives a click that lands early by less than the divergence window", () => {
    const corners = [5];
    const clicks = [5 - WINDOW / 2]; // 0.1s early
    expect(hasCrashed(corners, clicks, 4.95, HALF_WIDTH, SPEED)).toBe(false);
    expect(hasCrashed(corners, clicks, 8, HALF_WIDTH, SPEED)).toBe(false); // stays parallel after
  });

  it("survives a click that lands late by less than the divergence window", () => {
    const corners = [5];
    const clicks = [5 + WINDOW / 2]; // 0.1s late
    expect(hasCrashed(corners, clicks, 5.05, HALF_WIDTH, SPEED)).toBe(false);
    expect(hasCrashed(corners, clicks, 8, HALF_WIDTH, SPEED)).toBe(false);
  });

  it("crashes into the wall when a click is too early, before the corner even arrives", () => {
    const corners = [5];
    const clicks = [4.7]; // 0.3s early, more than the 0.2s window
    // The line has already drifted past the wall before the corridor's own
    // turn instant (t=5) — this is the "immediate failure" behaviour.
    expect(hasCrashed(corners, clicks, 4.95, HALF_WIDTH, SPEED)).toBe(true);
  });

  it("crashes shortly after the corner when the click never comes", () => {
    const corners = [5];
    const clicks: number[] = [];
    expect(hasCrashed(corners, clicks, 4.9, HALF_WIDTH, SPEED)).toBe(false); // hasn't reached the corner yet
    expect(hasCrashed(corners, clicks, 5.25, HALF_WIDTH, SPEED)).toBe(true); // drifted into the wall after it
  });

  it("crashes on a stray click well before the next corner", () => {
    // player clicks early, off the straight stretch before either corner is due
    const corners = [5, 6];
    const clicks = [1];
    expect(hasCrashed(corners, clicks, 1.3, HALF_WIDTH, SPEED)).toBe(true);
  });

  it("a wrong move is always possible: dropping any single corner's click eventually crashes", () => {
    const corners = [1, 2, 3, 4, 5];
    for (let i = 0; i < corners.length; i++) {
      const clicks = corners.filter((_, index) => index !== i);
      expect(hasCrashed(corners, clicks, corners[i] + 4 * WINDOW, HALF_WIDTH, SPEED)).toBe(true);
    }
  });

  it("an empty route with no clicks never crashes", () => {
    expect(hasCrashed([], [], 10, HALF_WIDTH, SPEED)).toBe(false);
  });
});
