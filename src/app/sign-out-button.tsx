"use client";

import { en } from "@/i18n/en.ts";

export function SignOutButton() {
  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }
  return (
    <button className="secondary" onClick={signOut}>
      {en.home.signOut}
    </button>
  );
}
