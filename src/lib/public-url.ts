// Behind Railway's proxy the app only sees its own internal address (https://localhost:8080), so a redirect built from
// req.url sends people to a dead link. Build redirects from the public address instead: APP_URL when set, otherwise the
// host the browser used (the proxy forwards it), otherwise the request's own address (local dev).
export function publicUrl(path: string, req: Request, env: Record<string, string | undefined> = process.env): URL {
  const app = env.APP_URL?.trim();
  if (app) return new URL(path, app);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
    return new URL(path, `${proto}://${host}`);
  }
  return new URL(path, req.url);
}
