// SPDX-License-Identifier: AGPL-3.0-or-later

export function isStale(lastSeenMs: number, nowMs: number, thresholdMs: number): boolean {
  return nowMs - lastSeenMs > thresholdMs;
}

export function calculateStaleThreshold(heartbeatMs: number, envMs?: number): number {
  const defaultThreshold = 3 * heartbeatMs;
  const floor = 5 * 60 * 1000; // 5 minutes
  const threshold = Math.max(defaultThreshold, floor);
  // envMs is pre-floored by the caller (index.ts), so use it directly if provided
  return envMs !== undefined ? envMs : threshold;
}
