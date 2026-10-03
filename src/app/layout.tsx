import type { ReactNode } from "react";
import { en } from "@/i18n/en.ts";
import "./globals.css";

export const metadata = { title: en.appName };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
