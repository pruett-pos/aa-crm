"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { en } from "@/i18n/en.ts";
import { CADENCES, type Cadence, type Schedule } from "@/lib/commission/periods.ts";

const errText = (code?: string) => (en.commission.errors as Record<string, string>)[code ?? ""] ?? en.commission.errors.generic;

export function ScheduleForm({ initial }: { initial: Schedule | null }) {
  const router = useRouter();
  const [cadence, setCadence] = useState<Cadence>(initial?.cadence ?? "biweekly");
  const [anchor, setAnchor] = useState(initial?.anchorDate ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const needsAnchor = cadence === "weekly" || cadence === "biweekly";

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings/commission-schedule", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ cadence, anchorDate: needsAnchor ? anchor : null }),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: errText(out.error) });
    setMsg({ ok: true, text: en.commission.scheduleSaved });
    router.refresh();
  }

  return (
    <form onSubmit={save} className="panel">
      <label htmlFor="cadence">{en.commission.cadence}</label>
      <select id="cadence" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
        {CADENCES.map((c) => <option key={c} value={c}>{en.commission.cadences[c]}</option>)}
      </select>
      {needsAnchor && (
        <>
          <label htmlFor="anchor">{en.commission.anchor}</label>
          <input id="anchor" type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} required />
          <p className="muted small-text">{en.commission.anchorHelp}</p>
        </>
      )}
      <div className="row">
        <button type="submit" disabled={busy}>{en.commission.saveSchedule}</button>
        {msg && <span className={msg.ok ? "ok" : "error"}>{msg.text}</span>}
      </div>
    </form>
  );
}
