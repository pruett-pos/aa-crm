"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";

export type DuplicateView = { customerId: string; name: string; candidates: { id: string; displayName: string; email: string | null }[] };
export type JobRowView = { id: string; kind: string; attempts: number; error: string | null; updatedAt: string; crmCents: number | null; qboCents: number | null };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
const usd = (c: number | null) => (c === null ? "-" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const kind = (k: string) => (en.quickbooks.kinds as Record<string, string>)[k] ?? k;

export function SyncClient(p: {
  configured: boolean; counts: { queued: number; failed: number; done: number; mismatch: number };
  failed: JobRowView[]; mismatches: JobRowView[]; pending: JobRowView[]; duplicates: DuplicateView[]; canLink: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function syncNow() {
    setBusy(true); setMsg(en.quickbooks.syncing);
    const res = await fetch("/api/quickbooks/sync", { method: "POST" }).catch(() => null);
    setBusy(false);
    if (!res) return setMsg(null);
    if (res.status === 409) return setMsg(en.quickbooks.notConnectedSync);
    const j = await res.json().catch(() => null);
    setMsg(j?.stoppedForAuth ? en.quickbooks.syncAuth : j ? en.quickbooks.syncResult(j.done, j.failed, j.retrying, j.waiting) : null);
    router.refresh();
  }
  async function act(id: string, action: "retry" | "review") {
    setBusy(true);
    await fetch(`/api/quickbooks/jobs/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    setBusy(false);
    router.refresh();
  }

  async function resolve(customerId: string, body: { action: "link"; qboId: string } | { action: "dismiss" }) {
    setBusy(true);
    await fetch(`/api/quickbooks/customers/${customerId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    router.refresh();
  }

  const table = (rows: JobRowView[], empty: string, button?: { label: string; action: "retry" | "review" }, amounts = false) =>
    rows.length === 0 ? <p className="muted">{empty}</p> : (
      <table className="lines">
        <thead><tr><th>{en.quickbooks.cols.what}</th><th>{en.quickbooks.cols.error}</th><th>{en.quickbooks.cols.tries}</th><th>{en.quickbooks.cols.when}</th>{amounts && <th>{en.quickbooks.cols.amounts}</th>}<th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{kind(r.kind)}</td><td>{r.error ?? ""}</td><td>{r.attempts}</td><td>{when(r.updatedAt)}</td>
              {amounts && <td>{usd(r.crmCents)} / {usd(r.qboCents)}</td>}
              <td>{button && <button type="button" disabled={busy} onClick={() => act(r.id, button.action)}>{button.label}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <>
      {!p.configured && <p className="warn">{en.quickbooks.notConfigured}</p>}
      <div className="panel">
        <dl>
          <div><dt>{en.quickbooks.queued}</dt><dd>{p.counts.queued}</dd></div>
          <div><dt>{en.quickbooks.failedCount}</dt><dd>{p.counts.failed}</dd></div>
          <div><dt>{en.quickbooks.doneCount}</dt><dd>{p.counts.done}</dd></div>
          <div><dt>{en.quickbooks.mismatchCount}</dt><dd>{p.counts.mismatch}</dd></div>
        </dl>
        <p><button type="button" disabled={busy || !p.configured} onClick={syncNow}>{en.quickbooks.syncNow}</button></p>
        {msg && <p role="status">{msg}</p>}
      </div>
      <div className="panel">
        <h2>{en.quickbooks.dupTitle}</h2>
        <p className="muted">{en.quickbooks.dupHelp}</p>
        {p.duplicates.length === 0 ? <p className="muted">{en.quickbooks.noDup}</p> : p.duplicates.map((d) => (
          <div key={d.customerId}>
            <p><strong>{d.name}</strong>. {en.quickbooks.dupFound(d.candidates.map((c) => c.displayName + (c.email ? ` (${c.email})` : "")).join("; "))}</p>
            {p.canLink && (
              <p>
                {d.candidates.map((c) => (
                  <button key={c.id} type="button" disabled={busy} onClick={() => resolve(d.customerId, { action: "link", qboId: c.id })}>{en.quickbooks.linkTo(c.displayName)}</button>
                ))}{" "}
                <button type="button" disabled={busy} onClick={() => resolve(d.customerId, { action: "dismiss" })}>{en.quickbooks.keepSeparate}</button>
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="panel"><h2>{en.quickbooks.failedTitle}</h2>{table(p.failed, en.quickbooks.noFailed, { label: en.quickbooks.retry, action: "retry" })}</div>
      <div className="panel"><h2>{en.quickbooks.mismatchTitle}</h2><p className="muted">{en.quickbooks.mismatchHelp}</p>{table(p.mismatches, en.quickbooks.noMismatch, { label: en.quickbooks.markReviewed, action: "review" }, true)}</div>
      <div className="panel"><h2>{en.quickbooks.pendingTitle}</h2>{table(p.pending, en.quickbooks.noPending)}</div>
    </>
  );
}
