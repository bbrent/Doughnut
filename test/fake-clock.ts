import type { Clock } from '../src/game/table';

/** Deterministic clock: timers run only when advanced. */
export class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  get pending() {
    return this.timers.length;
  }
  /** Advance time, running timers in order (including ones they schedule). */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const tm = this.timers[0];
      if (!tm || tm.at > end) break;
      this.timers.shift();
      this.t = tm.at;
      tm.fn();
    }
    this.t = end;
  }
  /** Run until nothing is scheduled or a limit is hit. */
  runAll(limitMs = 1e9) {
    while (this.timers.length && this.t < limitMs) this.advance(Math.max(1, this.timers[0].at - this.t));
  }
}
