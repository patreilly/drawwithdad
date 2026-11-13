import { describe, expect, it } from "vitest";
import { buildSteps, SessionClock } from "../src/session/clock";

const opts = { getReadyMs: 3000, advance: "auto" as const, warnSeconds: 3 };

describe("buildSteps", () => {
  it("expands segments and inserts breaks between images, never after the last", () => {
    const steps = buildSteps({ segments: [{ count: 2, seconds: 30 }, { count: 2, seconds: 60 }], breakEvery: 2, breakSeconds: 10 });
    expect(steps.map((s) => s.kind)).toEqual(["image", "image", "break", "image", "image"]);
    expect(steps[3]).toEqual({ kind: "image", imageIndex: 2, seconds: 60 });
  });
});

describe("SessionClock", () => {
  it("runs get-ready, drawing, then advances and finishes", () => {
    const c = new SessionClock(buildSteps({ segments: [{ count: 2, seconds: 5 }], breakEvery: 0, breakSeconds: 0 }), opts);
    expect(c.start()).toEqual([{ type: "phase", phase: "getReady" }]);
    expect(c.tick(3000)).toEqual([{ type: "phase", phase: "drawing" }]);
    expect(c.remainingMs).toBe(5000);
    const warns = c.tick(2500).concat(c.tick(1000));
    expect(warns).toEqual([{ type: "warn", secondsLeft: 3 }, { type: "warn", secondsLeft: 2 }]);
    c.tick(1500); // time's up -> next image's get-ready
    expect(c.phase).toBe("getReady");
    expect(c.step).toMatchObject({ imageIndex: 1 });
    c.tick(3000);
    expect(c.tick(5000)).toContainEqual({ type: "phase", phase: "done" });
  });

  it("does not advance while paused", () => {
    const c = new SessionClock(buildSteps({ segments: [{ count: 1, seconds: 5 }], breakEvery: 0, breakSeconds: 0 }), { ...opts, getReadyMs: 0 });
    c.start();
    c.togglePause();
    c.tick(10_000);
    expect(c.remainingMs).toBe(5000);
  });

  it("waits at time's up in manual mode, and +time resumes", () => {
    const c = new SessionClock(buildSteps({ segments: [{ count: 2, seconds: 1 }], breakEvery: 0, breakSeconds: 0 }), { ...opts, getReadyMs: 0, advance: "manual" });
    c.start();
    c.tick(1000);
    expect(c.phase).toBe("timeUp");
    c.tick(60_000);
    expect(c.stepIndex).toBe(0);
    c.addTime(30_000);
    expect(c.phase).toBe("drawing");
    expect(c.remainingMs).toBe(30_000);
  });

  it("treats untimed images as waiting for Next", () => {
    const c = new SessionClock(buildSteps({ segments: [{ count: 2, seconds: null }], breakEvery: 0, breakSeconds: 0 }), { ...opts, getReadyMs: 0 });
    c.start();
    c.tick(3_600_000);
    expect(c.stepIndex).toBe(0);
    c.next();
    expect(c.stepIndex).toBe(1);
  });

  it("prev skips breaks", () => {
    const c = new SessionClock(buildSteps({ segments: [{ count: 2, seconds: 5 }], breakEvery: 1, breakSeconds: 10 }), { ...opts, getReadyMs: 0 });
    c.start();
    c.next(); // break
    c.next(); // image 2
    expect(c.step).toMatchObject({ kind: "image", imageIndex: 1 });
    c.prev();
    expect(c.step).toMatchObject({ kind: "image", imageIndex: 0 });
  });
});
