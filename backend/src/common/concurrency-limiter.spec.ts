import { mapWithConcurrency, RateLimiter } from './concurrency-limiter';

describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)));
    expect(results).toEqual([30, 10, 20]);
  });

  it('never runs more than `concurrency` workers at once', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return i;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('handles an empty input array', async () => {
    await expect(mapWithConcurrency([], 3, async (x) => x)).resolves.toEqual([]);
  });
});

describe('RateLimiter', () => {
  it('allows up to maxPerSecond calls without delay', async () => {
    const limiter = new RateLimiter(5);
    const start = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('is a no-op when maxPerSecond is 0 or less', async () => {
    const limiter = new RateLimiter(0);
    const start = Date.now();
    for (let i = 0; i < 20; i++) await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });
});
