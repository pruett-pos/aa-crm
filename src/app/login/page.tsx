"use client";

import { useState, type FormEvent } from "react";
import { en } from "@/i18n/en.ts";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "limited">("idle");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setState("sending");
    const res = await fetch("/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setState(res.status === 429 ? "limited" : "sent");
  }

  if (state === "sent") {
    return (
      <>
        <h1>{en.login.sentTitle}</h1>
        <p>{en.login.sentBody}</p>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <h1>{en.login.title}</h1>
      <label htmlFor="email">{en.login.emailLabel}</label>
      <input
        id="email" type="email" autoComplete="email" required
        value={email} onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" disabled={state === "sending"}>
        {state === "sending" ? en.login.sending : en.login.submit}
      </button>
      {state === "limited" && <p className="error">{en.login.tooManyRequests}</p>}
    </form>
  );
}
