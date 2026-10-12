interface Sample {
  t: number;
  bytes: number;
}

export class SpeedMeter {
  private samples: Sample[] = [];
  private started: number | null = null;

  constructor(
    private readonly windowMs = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  add(bytes: number): void {
    const t = this.now();
    if (this.started === null) this.started = t;
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < 100) last.bytes += bytes;
    else this.samples.push({ t, bytes });
    this.prune(t);
  }

  get bytesPerSecond(): number {
    const t = this.now();
    this.prune(t);
    if (this.started === null || this.samples.length === 0) return 0;
    const total = this.samples.reduce((sum, s) => sum + s.bytes, 0);
    const span = Math.max(1000, Math.min(this.windowMs, t - this.started));
    return (total * 1000) / span;
  }

  reset(): void {
    this.samples = [];
    this.started = null;
  }

  private prune(t: number): void {
    while (this.samples.length > 0 && t - this.samples[0].t > this.windowMs) this.samples.shift();
  }
}

export function estimateEta(remaining: number | null, bytesPerSecond: number): number | null {
  if (remaining === null || bytesPerSecond <= 0) return null;
  return remaining / bytesPerSecond;
}
