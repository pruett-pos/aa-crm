import pg from "pg";

/** Railway's private address needs no TLS; the public proxy address does. */
export function connectionSettings(url: string): pg.ClientConfig {
  const ssl = new URL(url).hostname.endsWith(".railway.internal") || ["localhost", "127.0.0.1"].includes(new URL(url).hostname)
    ? undefined : { rejectUnauthorized: false };
  return { connectionString: url, ssl };
}
