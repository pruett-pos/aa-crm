"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { en } from "@/i18n/en.ts";
import type { AerialSettings } from "@/lib/aerial/types.ts";

const s = en.aerial.settings;
const errText = (code?: string) => (s.errors as Record<string, string>)[code ?? ""] ?? s.errors.generic;

export function AerialSettingsForm({ initial }: { initial: AerialSettings }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [f, setF] = useState({
    wastePct: String(initial.wasteBps / 100), correctionPct: String(initial.correctionBps / 100),
    eavesFtPerSq: String(initial.eavesFt10PerSq / 10), rakesFtPerSq: String(initial.rakesFt10PerSq / 10),
    ridgesHipsFtPerSq: String(initial.ridgesHipsFt10PerSq / 10), valleysFtPerSq: String(initial.valleysFt10PerSq / 10),
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof f, label: string, step: string, min: number, max: number) => (
    <div>
      <label htmlFor={key}>{label}</label>
      <input id={key} type="number" inputMode="decimal" step={step} min={min} max={max} required value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </div>
  );

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/settings/aerial", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v)])) }),
    }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string; message?: string };
    setBusy(false);
    if (!res?.ok) return setMsg({ ok: false, text: out.message ?? errText(out.error) });
    setMsg({ ok: true, text: s.saved });
    router.refresh();
  }

  return (
    <form onSubmit={save} className="panel">
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {s.enabled}</label>
      {field("correctionPct", s.correction, "0.1", 50, 150)}
      <p className="muted small-text">{s.correctionHelp}</p>
      {field("wastePct", s.waste, "0.5", 0, 30)}
      <h2>{s.lengthsTitle}</h2>
      <p className="muted small-text">{s.lengthsHelp}</p>
      <div className="row">
        {field("eavesFtPerSq", s.eaves, "0.1", 0, 50)}
        {field("rakesFtPerSq", s.rakes, "0.1", 0, 50)}
        {field("ridgesHipsFtPerSq", s.ridgesHips, "0.1", 0, 50)}
        {field("valleysFtPerSq", s.valleys, "0.1", 0, 50)}
      </div>
      <div className="row">
        <button type="submit" disabled={busy}>{s.save}</button>
        {msg && <span className={msg.ok ? "ok" : "error"} role="status">{msg.text}</span>}
      </div>
    </form>
  );
}
