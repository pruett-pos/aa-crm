// Health check. Public (Railway and uptime monitors call it without signing in), so it reveals nothing but ok/not ok.
export type HealthResult = { status: 200 | 503; body: { status: "ok" | "down"; db: "ok" | "down" } };

export async function checkHealth(pingDb: () => Promise<unknown>, timeoutMs = 3000): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pingDb(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("database check timed out")), timeoutMs); }),
    ]);
    return { status: 200, body: { status: "ok", db: "ok" } };
  } catch {
    return { status: 503, body: { status: "down", db: "down" } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
