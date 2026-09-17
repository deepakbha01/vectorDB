/**
 * Runs `items` through `worker` with at most `concurrency` in flight at once,
 * preserving input order in the returned results. Used to bound embedding
 * request concurrency during ingestion without adding a dependency.
 */
export async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await runNext();
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runNext());
  await Promise.all(workers);
  return results;
}

/** Simple fixed-rate limiter: blocks until fewer than `maxPerSecond` calls have started in the trailing 1s window. */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxPerSecond: number) {}

  async acquire(): Promise<void> {
    if (this.maxPerSecond <= 0) return;
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);
    if (this.timestamps.length >= this.maxPerSecond) {
      const waitMs = 1000 - (now - this.timestamps[0]);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs)));
      return this.acquire();
    }
    this.timestamps.push(Date.now());
  }
}
