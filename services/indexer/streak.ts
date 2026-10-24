/**
 * A loop's failures, as an operator should hear of them. A public node answers
 * 504 now and then and the next poll goes through: that is not an incident.
 * Failures that keep coming — no pause between them longer than `gapMs` — for
 * `lastingMs` are, said once per streak with the latest error.
 */

const LASTING_MS = 5 * 60_000;
/** Longer than a poll and the longest restart backoff: a pause this long means it recovered. */
const GAP_MS = 2 * 60_000;

export class FailureStreak {
  private readonly say: (detail: string) => void;
  private readonly lastingMs: number;
  private readonly gapMs: number;
  private since: number | undefined;
  private last = 0;
  private said = false;

  constructor(say: (detail: string) => void, { lastingMs = LASTING_MS, gapMs = GAP_MS } = {}) {
    this.say = say;
    this.lastingMs = lastingMs;
    this.gapMs = gapMs;
  }

  failed(message: string, now = Date.now()): void {
    if (this.since === undefined || now - this.last > this.gapMs) {
      this.since = now;
      this.said = false;
    }
    this.last = now;
    if (this.said || now - this.since < this.lastingMs) return;
    this.said = true;
    this.say(`failing for ${Math.round((now - this.since) / 60_000)} min: ${message}`);
  }
}
