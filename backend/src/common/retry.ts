/** Retries `fn` up to `retryCount` additional times with exponential backoff, starting at `backoffMs`. */
export async function retryWithBackoff<T>(fn: () => Promise<T>, retryCount: number, backoffMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retryCount) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** attempt));
      }
    }
  }
  throw lastError;
}
