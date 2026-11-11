"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";

type State = "not_configured" | "not_connected" | "connected" | "needs_reconnect";
type Row = { key: string; label: string; value: string; fallback: string };
const day = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

export function QuickBooksSettingsClient(p: {
  state: State; company: string | null; environment: string | null; syncFrom: string | null; classes: Row[]; items: Row[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [classes, setClasses] = useState(Object.fromEntries(p.classes.map((r) => [r.key, r.value])));
  const [items, setItems] = useState(Object.fromEntries(p.items.map((r) => [r.key, r.value])));

  async function disconnect() {
    if (!window.confirm(en.quickbooks.disconnectConfirm)) return;
    setBusy(true);
    const res = await fetch("/api/quickbooks/disconnect", { method: "POST" }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setMsg(en.quickbooks.disconnected); router.refresh(); }
  }

  async function save() {
    setBusy(true); setMsg(null); setErr(null);
    const res = await fetch("/api/quickbooks/mappings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classes, items }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setMsg(en.quickbooks.savedMappings); router.refresh(); } else setErr(en.quickbooks.mappingError);
  }

  const table = (title: string, help: string, rows: Row[], values: Record<string, string>, set: (v: Record<string, string>) => void) => (
    <div className="panel">
      <h2>{title}</h2>
      <p className="muted">{help}</p>
      <table className="lines"><tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td><label htmlFor={`qbo-${title}-${r.key}`}>{r.label}</label></td>
            <td><input id={`qbo-${title}-${r.key}`} maxLength={100} value={values[r.key] ?? ""} placeholder={r.fallback} onChange={(e) => set({ ...values, [r.key]: e.target.value })} /></td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );

  return (
    <>
      <div className="panel">
        {p.state === "not_configured" && <p className="warn">{en.quickbooks.notConfigured}</p>}
        {p.state === "not_connected" && <p>{en.quickbooks.notConnected}</p>}
        {p.state === "needs_reconnect" && <p className="warn">{en.quickbooks.needsReconnect}</p>}
        {p.state === "connected" && <p className="ok">{en.quickbooks.connected(p.company ?? "QuickBooks", p.environment ?? "")}</p>}
        {p.state !== "not_configured" && p.environment === "sandbox" && <p className="muted">{en.quickbooks.sandboxNote}</p>}
        {p.state === "connected" && p.syncFrom && <p className="muted">{en.quickbooks.syncedFrom(day(p.syncFrom))}</p>}
        {msg && <p className="ok" role="status">{msg}</p>}
        {(p.state === "not_connected" || p.state === "needs_reconnect") && (
          <p><a href="/api/quickbooks/connect">{p.state === "needs_reconnect" ? en.quickbooks.reconnect : en.quickbooks.connect}</a></p>
        )}
        {(p.state === "connected" || p.state === "needs_reconnect") && (
          <p><button type="button" disabled={busy} onClick={disconnect}>{en.quickbooks.disconnect}</button></p>
        )}
      </div>
      {table(en.quickbooks.classesTitle, en.quickbooks.classesHelp, p.classes, classes, setClasses)}
      {table(en.quickbooks.itemsTitle, en.quickbooks.itemsHelp, p.items, items, setItems)}
      <p>
        <button type="button" disabled={busy} onClick={save}>{en.quickbooks.saveMappings}</button>{" "}
        {err && <span className="error" role="alert">{err}</span>}
      </p>
    </>
  );
}
