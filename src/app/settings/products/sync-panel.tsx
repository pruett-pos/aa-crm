"use client";

import { useState } from "react";
import { en } from "@/i18n/en.ts";
import type { SyncRunView } from "@/lib/catalog/price-sync.ts";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
const errText = (code?: string) => (en.priceSync.errors as Record<string, string>)[code ?? ""] ?? en.priceSync.errors.generic;

// Admin only (the page and the API both check). Shows how the last Pruett price sync went and lets an admin run one now.
export function SyncPanel({ initial }: { initial: SyncRunView | null }) {
  const [run, setRun] = useState<SyncRunView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function sync() {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings/products/sync", { method: "POST" }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as { run?: SyncRunView; error?: string };
    setBusy(false);
    if (!res?.ok || !out.run) return setMsg({ ok: false, text: errText(res?.status === 429 ? "rate_limited" : out.error) });
    setRun(out.run);
    if (out.run.status !== "error") setMsg({ ok: true, text: en.priceSync.done });
  }

  return (
    <section className="report">
      <h2>{en.priceSync.title}</h2>
      <p className="muted">{en.priceSync.help}</p>
      {!run && <p>{en.priceSync.never}</p>}
      {run && (
        <p>
          <strong>{en.priceSync.last}:</strong> {when(run.startedAt)} · {en.priceSync.trigger[run.trigger]} · {en.priceSync.status[run.status]}
          <br />
          {en.priceSync.counts(run.itemsSeen, run.itemsNew, run.itemsChanged, run.itemsDeactivated)}
          {run.warning && <><br /><strong>{en.priceSync.warning}:</strong> {run.warning}</>}
          {run.error && <><br /><span className="error"><strong>{en.priceSync.error}:</strong> {run.error}</span></>}
        </p>
      )}
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      <p><button type="button" disabled={busy} onClick={sync}>{busy ? en.priceSync.running : en.priceSync.button}</button></p>
    </section>
  );
}
