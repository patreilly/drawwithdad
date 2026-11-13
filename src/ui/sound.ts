/** Beeps made with WebAudio, so there are no sound files to ship. */
export class Sound {
  private ctx: AudioContext | null = null;

  constructor(
    private enabled: boolean,
    private volume: number,
  ) {}

  /** Must be called from a user gesture (e.g. the Start click) so browsers allow audio. */
  unlock(): void {
    if (!this.enabled || this.ctx) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      this.enabled = false;
    }
  }

  warn(): void {
    this.tone(880, 0.08);
  }

  change(): void {
    this.tone(660, 0.12);
    this.tone(990, 0.18, 0.12);
  }

  private tone(freq: number, duration: number, delay = 0): void {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || this.volume <= 0) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3 * this.volume, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  close(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
