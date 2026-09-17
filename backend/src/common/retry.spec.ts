import { retryWithBackoff } from './retry';

describe('retryWithBackoff', () => {
  it('returns the result on first success without waiting', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retryWithBackoff(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to retryCount additional times then succeeds', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('fail 1')).mockRejectedValueOnce(new Error('fail 2')).mockResolvedValue('ok');
    await expect(retryWithBackoff(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws the last error once retries are exhausted', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(retryWithBackoff(fn, 2, 1)).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
