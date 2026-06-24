// SPDX-License-Identifier: AGPL-3.0-or-later

const MIN_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes minimum

export function isStale(lastSeenMs: number, nowMs: number, thresholdMs: number): boolean {
  return nowMs - lastSeenMs > thresholdMs;
}

export function calculateStaleThreshold(heartbeatMs: number, envMs?: number): number {
  const defaultThreshold = 3 * heartbeatMs;
  const threshold = Math.max(defaultThreshold, MIN_STALE_THRESHOLD_MS);
  return envMs !== undefined ? Math.max(envMs, MIN_STALE_THRESHOLD_MS) : threshold;
}
