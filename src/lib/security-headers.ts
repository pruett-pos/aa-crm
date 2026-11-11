// Security headers. The static ones are applied in next.config.ts; the Content-Security-Policy needs a fresh nonce
// per request, so it is built here and set in proxy.ts.

export const STATIC_SECURITY_HEADERS = [
  // The signing screen shows the contract PDF in a same-origin iframe, so SAMEORIGIN (not DENY).
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
] as const;

/**
 * CSP for a Next.js App Router app (see node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 * - Scripts: only this site's, plus Next's own inline scripts that carry the per-request nonce ('strict-dynamic').
 * - Styles: 'unsafe-inline' because React renders style="" attributes, which a nonce cannot cover. Styles cannot run code.
 * - Images: https: is open because CompanyCam serves job photo thumbnails from hosts CompanyCam does not publish.
 * - The contract PDF is shown in a same-origin iframe, and Chrome's PDF viewer needs object-src 'self'.
 */
export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  const dev = opts.dev ?? process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function newNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}
