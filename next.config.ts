import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security-headers.ts";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    // The Content-Security-Policy is set per request in src/proxy.ts (it carries a nonce).
    return [{ source: "/:path*", headers: STATIC_SECURITY_HEADERS.map((h) => ({ ...h })) }];
  },
};

export default nextConfig;
