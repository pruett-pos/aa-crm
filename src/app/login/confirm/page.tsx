"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { en } from "@/i18n/en.ts";

function Confirm() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "invalid">(token ? "idle" : "invalid");

  async function signIn() {
    setState("working");
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) window.location.assign("/");
    else setState("invalid");
  }

  if (state === "invalid") {
    return (
      <>
        <h1>{en.login.confirmTitle}</h1>
        <p className="error">{en.login.invalidLink}</p>
        <p><a href="/login">{en.login.backToLogin}</a></p>
      </>
    );
  }
  return (
    <>
      <h1>{en.login.confirmTitle}</h1>
      <button onClick={signIn} disabled={state === "working"}>
        {state === "working" ? en.login.confirmWorking : en.login.confirmSubmit}
      </button>
    </>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense>
      <Confirm />
    </Suspense>
  );
}
