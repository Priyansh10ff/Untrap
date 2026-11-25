/**
 * Keeps cloud calls under the Gemini API's per-minute limit, and recognises "slow down" errors.
 *
 * On Firebase's free plan the cloud model has a small per-minute quota. Going over it doesn't
 * just fail one call: every check after it fails too until the minute is up. So Untrap paces
 * itself, and when the API still says "too many requests" it waits as long as the API asks.
 */

/** Allows at most `perMinute` calls in any 60-second window. */
export class RatePacer {
  private calls: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** How long to wait before the next call is allowed (0 if it can go now). */
  waitMs(): number {
    const t = this.now();
    this.calls = this.calls.filter((c) => t - c < 60_000);
    if (this.calls.length < this.perMinute) return 0;
    return 60_000 - (t - this.calls[0]!);
  }

  /** Call right before each request. */
  record(): void {
    this.calls.push(this.now());
  }
}

/**
 * If the error means "too many requests" or "quota used up", how long the API asked us to wait
 * (or a sensible default). Null for any other error.
 */
export function quotaRetryMs(err: unknown): number | null {
  const e = err as { message?: unknown; code?: unknown; status?: unknown; customErrorData?: { status?: unknown } } | null;
  const text = [e?.message, e?.code, e?.status, e?.customErrorData?.status].filter((x) => x !== undefined).map(String).join(" ");
  if (!/\b429\b|resource[_ ]exhausted|quota|rate.?limit|too many requests/i.test(text)) return null;
  const m = text.match(/retry(?:Delay)?["':\s]*(?:in\s+)?([\d.]+)\s*s/i);
  const seconds = m ? Number(m[1]) : 30;
  return Math.min(Math.max(Math.ceil(seconds * 1000), 1_000), 10 * 60_000);
}
