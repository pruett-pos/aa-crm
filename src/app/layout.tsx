import type { ReactNode } from "react";
import { en } from "@/i18n/en.ts";
import "./globals.css";

export const metadata = { title: en.appName };

// Every page is rendered per request. The Content-Security-Policy carries a fresh nonce for each request (src/proxy.ts),
// which a prerendered static page cannot have, so its scripts would be blocked.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
