import { retry } from 'src/pkg/utils/retry';

describe('retry', () => {
  it('returns immediately on success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(
      retry(fn, { attempts: 3, initialDelayMs: 1, maxDelayMs: 2 }),
    ).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries with capped exponential delays', async () => {
    jest.useFakeTimers();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('one'))
      .mockRejectedValueOnce(new Error('two'))
      .mockResolvedValue('ok');
    const promise = retry(fn, {
      attempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 15,
    });
    await jest.advanceTimersByTimeAsync(25);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('stops for non-retryable errors and rethrows the final error', async () => {
    const fatal = new Error('fatal');
    await expect(
      retry(() => Promise.reject(fatal), {
        attempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 1,
        isRetryable: () => false,
      }),
    ).rejects.toBe(fatal);

    jest.useFakeTimers();
    const exhausted = retry(() => Promise.reject(fatal), {
      attempts: 2,
      initialDelayMs: 1,
      maxDelayMs: 1,
    });
    const rejection = expect(exhausted).rejects.toBe(fatal);
    await jest.advanceTimersByTimeAsync(1);
    await rejection;
    jest.useRealTimers();
  });
});
