"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";

type Result = { status: "ok" | "no_data" | "error" | "skipped"; reason?: string };

/** Admin only: ask Google again for this property. The server checks the role. */
export function FetchAgainButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/jobs/${jobId}/aerial`, { method: "POST" }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as { result?: Result };
    setBusy(false);
    const r = out.result;
    if (!res?.ok || !r) return setMsg({ ok: false, text: en.aerial.fetchResult.error });
    const text = r.status === "skipped"
      ? (en.aerial.skipReasons as Record<string, string>)[r.reason ?? ""] ?? en.aerial.fetchResult.skipped
      : en.aerial.fetchResult[r.status];
    setMsg({ ok: r.status === "ok", text });
    router.refresh();
  }

  return (
    <div className="row">
      <button type="button" onClick={run} disabled={busy}>{busy ? en.aerial.fetching : en.aerial.fetchAgain}</button>
      {msg && <span className={msg.ok ? "ok" : "error"} role="status">{msg.text}</span>}
    </div>
  );
}
