// Fixed-window limiter, per server instance. Fine for one Railway service;
// move to the database if the app ever runs on several instances.

const hits = new Map<string, { count: number; resetAt: number }>();

export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

export function resetRateLimits() {
  hits.clear();
}
