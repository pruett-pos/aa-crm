// Request timeout that keeps the event loop alive while it waits.
//
// `AbortSignal.timeout(ms)` uses an unref'd timer on current Node 22, so a process that is only waiting on the
// timeout (a test with a fake fetch, a script) exits early instead of firing it. This helper uses a normal timer
// and always clears it, so nothing lingers after the request finishes.

export async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
