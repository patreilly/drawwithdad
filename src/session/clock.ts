import type { SessionSettings } from "./settings";

export type Step =
  | { kind: "image"; imageIndex: number; seconds: number | null }
  | { kind: "break"; seconds: number };

export type Phase = "getReady" | "drawing" | "timeUp" | "break" | "done";

export type ClockEvent =
  | { type: "phase"; phase: Phase }
  | { type: "warn"; secondsLeft: number };

export function buildSteps(settings: Pick<SessionSettings, "segments" | "breakEvery" | "breakSeconds">): Step[] {
  const steps: Step[] = [];
  const total = settings.segments.reduce((n, s) => n + s.count, 0);
  let imageIndex = 0;
  for (const seg of settings.segments) {
    for (let i = 0; i < seg.count; i++) {
      steps.push({ kind: "image", imageIndex, seconds: seg.seconds });
      imageIndex++;
      if (settings.breakEvery > 0 && imageIndex % settings.breakEvery === 0 && imageIndex < total) {
        steps.push({ kind: "break", seconds: settings.breakSeconds });
      }
    }
  }
  return steps;
}

export interface ClockOptions {
  getReadyMs: number;
  advance: "auto" | "manual";
  warnSeconds: number;
}

/**
 * The session timer as a pure state machine. The UI calls tick() with elapsed
 * milliseconds and reacts to the returned events. No timers live in here, so
 * it's trivial to test.
 */
export class SessionClock {
  stepIndex = -1;
  phase: Phase = "getReady";
  /** Milliseconds left in the current phase (Infinity while drawing untimed). */
  remainingMs = 0;
  /** Milliseconds spent drawing the current image (excludes pauses). */
  drawingElapsedMs = 0;
  paused = false;

  constructor(
    readonly steps: Step[],
    private readonly opts: ClockOptions,
  ) {}

  get step(): Step | undefined {
    return this.steps[this.stepIndex];
  }

  get imageCount(): number {
    return this.steps.filter((s) => s.kind === "image").length;
  }

  start(): ClockEvent[] {
    return this.enterStep(0);
  }

  tick(dtMs: number): ClockEvent[] {
    if (this.paused || this.phase === "done" || this.phase === "timeUp") return [];
    const events: ClockEvent[] = [];

    switch (this.phase) {
      case "getReady":
        this.remainingMs -= dtMs;
        if (this.remainingMs <= 0) events.push(...this.startDrawing());
        break;

      case "drawing": {
        this.drawingElapsedMs += dtMs;
        if (!Number.isFinite(this.remainingMs)) break;
        const before = this.remainingMs;
        this.remainingMs -= dtMs;
        for (let s = this.opts.warnSeconds; s >= 1; s--) {
          if (before > s * 1000 && this.remainingMs <= s * 1000) events.push({ type: "warn", secondsLeft: s });
        }
        if (this.remainingMs <= 0) {
          this.remainingMs = 0;
          if (this.opts.advance === "auto") {
            events.push(...this.enterStep(this.stepIndex + 1));
          } else {
            this.phase = "timeUp";
            events.push({ type: "phase", phase: "timeUp" });
          }
        }
        break;
      }

      case "break":
        this.remainingMs -= dtMs;
        if (this.remainingMs <= 0) events.push(...this.enterStep(this.stepIndex + 1));
        break;
    }
    return events;
  }

  next(): ClockEvent[] {
    if (this.phase === "done") return [];
    return this.enterStep(this.stepIndex + 1);
  }

  /** Back to the previous image, skipping breaks. Restarts the current one if it's the first. */
  prev(): ClockEvent[] {
    if (this.phase === "done") return [];
    for (let j = this.stepIndex - 1; j >= 0; j--) {
      if (this.steps[j].kind === "image") return this.enterStep(j);
    }
    return this.enterStep(Math.max(0, this.stepIndex));
  }

  /** Restarts the current step, e.g. after its image was swapped out. */
  restart(): ClockEvent[] {
    if (this.phase === "done") return [];
    return this.enterStep(this.stepIndex);
  }

  togglePause(): void {
    if (this.phase !== "done") this.paused = !this.paused;
  }

  addTime(ms: number): ClockEvent[] {
    if (this.phase === "timeUp") {
      this.remainingMs = ms;
      this.phase = "drawing";
      return [{ type: "phase", phase: "drawing" }];
    }
    if (this.phase === "drawing" && Number.isFinite(this.remainingMs)) this.remainingMs += ms;
    return [];
  }

  finish(): ClockEvent[] {
    this.stepIndex = this.steps.length;
    this.phase = "done";
    return [{ type: "phase", phase: "done" }];
  }

  private enterStep(index: number): ClockEvent[] {
    this.stepIndex = index;
    this.drawingElapsedMs = 0;
    const step = this.steps[index];
    if (!step) return this.finish();
    if (step.kind === "break") {
      this.phase = "break";
      this.remainingMs = step.seconds * 1000;
      return [{ type: "phase", phase: "break" }];
    }
    if (this.opts.getReadyMs > 0) {
      this.phase = "getReady";
      this.remainingMs = this.opts.getReadyMs;
      return [{ type: "phase", phase: "getReady" }];
    }
    return this.startDrawing();
  }

  private startDrawing(): ClockEvent[] {
    const step = this.step;
    this.phase = "drawing";
    this.drawingElapsedMs = 0;
    this.remainingMs = step?.kind === "image" && step.seconds !== null ? step.seconds * 1000 : Infinity;
    return [{ type: "phase", phase: "drawing" }];
  }
}
