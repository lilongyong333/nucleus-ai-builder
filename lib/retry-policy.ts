export function boundedExponentialDelayMs(attemptCount: number, baseDelayMs: number, maxAttempts: number, maximumDelayMs = 6 * 60 * 60_000): number {
  const attempt = Math.max(1, Math.min(maxAttempts, Math.floor(attemptCount)));
  return Math.min(maximumDelayMs, baseDelayMs * (2 ** (attempt - 1)));
}
