"use client";

import { useCallback, useEffect, useState } from "react";
import { en } from "@/i18n/en.ts";
import type { HoverCandidate, MeasurementRow, MeasurementView } from "@/lib/measurements/logic.ts";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric" });
const errText = (code?: string) => (en.measurements.errors as Record<string, string>)[code ?? ""] ?? en.measurements.errors.generic;
type Msg = { ok: boolean; text: string } | null;
type PitchInput = { pitch: string; area: string };

export function MeasurementsPanel({ jobId }: { jobId: string }) {
  const [view, setView] = useState<MeasurementView | null>(null);
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/jobs/${jobId}/measurements`).catch(() => null);
    if (res?.ok) { setView((await res.json()) as MeasurementView); setFailed(false); } else setFailed(true);
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function post(body: unknown): Promise<{ ok: boolean; out: Record<string, unknown> }> {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/jobs/${jobId}/measurements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    setBusy(false);
    if (!res?.ok) setMsg({ ok: false, text: errText(res?.status === 429 ? "rate_limited" : (out.error as string | undefined)) });
    return { ok: !!res?.ok, out };
  }

  if (failed) return null;                                   // not allowed to see measurements (or the page is loading): show nothing
  if (!view) return <section className="report"><h2>{en.measurements.title}</h2></section>;

  return (
    <section className="report">
      <h2>{en.measurements.title}</h2>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      {view.current ? <Values row={view.current} /> : <p className="muted">{en.measurements.none}</p>}
      {view.locked && <p className="muted small-text">{en.measurements.locked}</p>}
      {view.canEdit && view.current && view.job.divisions.includes("roofing") && <BuildScopes jobId={jobId} />}
      {view.canEdit && (
        <>
          <HoverSearch post={post} busy={busy} done={async (t) => { setMsg({ ok: true, text: t }); await load(); }} />
          <ManualForm post={post} busy={busy} done={async (t) => { setMsg({ ok: true, text: t }); await load(); }} />
        </>
      )}
      {view.history.length > 0 && (
        <details>
          <summary>{en.measurements.history}</summary>
          {view.history.map((h) => <div key={h.id} className="muted small-text">{en.measurements.source[h.source]} · {en.measurements.measuredOn(day(h.createdAt))} · {h.roofAreaSqft.toLocaleString("en-US")} {en.measurements.sqft} ({h.squares} sq)</div>)}
        </details>
      )}
    </section>
  );
}

function Values({ row: r }: { row: MeasurementRow }) {
  const m = en.measurements;
  const ft = (n: number) => `${n.toLocaleString("en-US")} ${m.ft}`;
  return (
    <div>
      <p className="muted small-text">{m.source[r.source]} · {m.measuredOn(day(r.createdAt))}{r.note ? ` · ${r.note}` : ""}</p>
      <dl>
        <div><dt>{m.roofArea}</dt><dd>{r.roofAreaSqft.toLocaleString("en-US")} {m.sqft}</dd></div>
        <div><dt>{m.squares}</dt><dd>{r.squares}</dd></div>
        {r.wasteSquares.map((w) => <div key={w.pct}><dt>{m.withWaste(w.pct)}</dt><dd>{w.squares}</dd></div>)}
        {r.facets !== null && <div><dt>{m.facets}</dt><dd>{r.facets}</dd></div>}
        <div><dt>{m.ridgesHips}</dt><dd>{ft(r.ridgesHipsFt)}</dd></div>
        <div><dt>{m.valleys}</dt><dd>{ft(r.valleysFt)}</dd></div>
        <div><dt>{m.rakes}</dt><dd>{ft(r.rakesFt)}</dd></div>
        <div><dt>{m.eaves}</dt><dd>{ft(r.eavesFt)}</dd></div>
        <div><dt>{m.flashing}</dt><dd>{ft(r.flashingFt)}</dd></div>
        <div><dt>{m.stepFlashing}</dt><dd>{ft(r.stepFlashingFt)}</dd></div>
        {r.sidingAreaSqft !== null && <div><dt>{m.siding}</dt><dd>{r.sidingAreaSqft.toLocaleString("en-US")} {m.sqft}</dd></div>}
      </dl>
      {r.pitches.length > 0 && <p className="small-text">{m.pitches}: {r.pitches.map((p) => `${p.pitch} (${p.areaSqft.toLocaleString("en-US")} ${m.sqft})`).join(", ")}</p>}
    </div>
  );
}

type Post = (body: unknown) => Promise<{ ok: boolean; out: Record<string, unknown> }>;

function HoverSearch({ post, busy, done }: { post: Post; busy: boolean; done: (t: string) => Promise<void> }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<HoverCandidate[] | null>(null);

  async function search() {
    const r = await post({ action: "search", query: q.trim() === "" ? null : q });
    if (r.ok) setFound((r.out.candidates as HoverCandidate[]) ?? []);
  }
  async function pull(c: HoverCandidate) {
    if (!c.readyModelId) return;
    const r = await post({ action: "import", hoverJobId: c.hoverJobId, modelId: c.readyModelId, query: q.trim() === "" ? null : q });
    if (r.ok) { setFound(null); await done(en.measurements.imported); }
  }

  return (
    <details className="noprint">
      <summary>{en.measurements.hoverTitle}</summary>
      <p>
        <label>{en.measurements.searchLabel}<br />
          <input value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void search(); }} />
        </label>{" "}
        <button type="button" disabled={busy} onClick={search}>{en.measurements.search}</button>
      </p>
      {found && found.length === 0 && <p className="muted">{en.measurements.noResults}</p>}
      {found?.map((c) => (
        <p key={c.hoverJobId}>
          {c.name ?? c.address} <span className="muted">· {c.address}</span>{" "}
          <span className={c.addressMatches ? "ok" : "muted"}>{c.addressMatches ? en.measurements.addressMatches : en.measurements.addressDiffers}</span>{" "}
          {c.readyModelId
            ? <button type="button" disabled={busy} onClick={() => pull(c)}>{en.measurements.importButton}</button>
            : <span className="muted">{en.measurements.notReady}</span>}
        </p>
      ))}
    </details>
  );
}

function ManualForm({ post, busy, done }: { post: Post; busy: boolean; done: (t: string) => Promise<void> }) {
  const m = en.measurements;
  const [v, setV] = useState({ roofAreaSqft: "", facets: "", ridgesHipsFt: "", valleysFt: "", rakesFt: "", eavesFt: "", flashingFt: "", stepFlashingFt: "", sidingAreaSqft: "", note: "" });
  const [pitches, setPitches] = useState<PitchInput[]>([]);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const num = (s: string) => (s.trim() === "" ? 0 : s.trim());

  async function save() {
    const r = await post({
      action: "manual", note: v.note.trim() === "" ? null : v.note,
      values: {
        roofAreaSqft: v.roofAreaSqft.trim(), facets: v.facets.trim() === "" ? null : v.facets.trim(),
        pitches: pitches.filter((p) => p.pitch.trim() !== "").map((p) => ({ pitch: p.pitch.trim(), areaSqft: p.area.trim(), percent: null })),
        ridgesHipsFt: num(v.ridgesHipsFt), valleysFt: num(v.valleysFt), rakesFt: num(v.rakesFt), eavesFt: num(v.eavesFt),
        flashingFt: num(v.flashingFt), stepFlashingFt: num(v.stepFlashingFt), sidingAreaSqft: v.sidingAreaSqft.trim() === "" ? null : v.sidingAreaSqft.trim(),
      },
    });
    if (r.ok) await done(m.saved);
  }

  const field = (label: string, k: keyof typeof v) => (
    <p><label>{label}<br /><input inputMode="decimal" value={v[k]} maxLength={20} onChange={set(k)} /></label></p>
  );
  return (
    <details className="noprint">
      <summary>{m.manualTitle}</summary>
      {field(m.roofAreaLabel, "roofAreaSqft")}
      {field(m.facetsLabel, "facets")}
      {field(m.ridgesHipsLabel, "ridgesHipsFt")}
      {field(m.valleysLabel, "valleysFt")}
      {field(m.rakesLabel, "rakesFt")}
      {field(m.eavesLabel, "eavesFt")}
      {field(m.flashingLabel, "flashingFt")}
      {field(m.stepFlashingLabel, "stepFlashingFt")}
      {field(m.sidingLabel, "sidingAreaSqft")}
      {pitches.map((p, i) => (
        <p key={i}>
          <input aria-label={m.pitchLabel} placeholder={m.pitchLabel} value={p.pitch} maxLength={10} onChange={(e) => setPitches((xs) => xs.map((x, k) => (k === i ? { ...x, pitch: e.target.value } : x)))} />{" "}
          <input aria-label={m.pitchAreaLabel} placeholder={m.pitchAreaLabel} inputMode="decimal" value={p.area} maxLength={20} onChange={(e) => setPitches((xs) => xs.map((x, k) => (k === i ? { ...x, area: e.target.value } : x)))} />{" "}
          <button type="button" onClick={() => setPitches((xs) => xs.filter((_, k) => k !== i))}>{m.removePitch}</button>
        </p>
      ))}
      {pitches.length < 12 && <p><button type="button" onClick={() => setPitches((xs) => [...xs, { pitch: "", area: "" }])}>{m.addPitch}</button></p>}
      <p><label>{m.noteLabel}<br /><input value={v.note} maxLength={300} onChange={set("note")} /></label></p>
      <button type="button" disabled={busy || v.roofAreaSqft.trim() === ""} onClick={save}>{m.save}</button>
    </details>
  );
}

type Skipped = { tier: string; role: string; reason: string };

/** Build the Good, Better and Best roofing scopes from the current measurements and the assembly settings. */
function BuildScopes({ jobId }: { jobId: string }) {
  const e = en.estimating;
  const [waste, setWaste] = useState("10");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [needsReplace, setNeedsReplace] = useState(false);
  const [left, setLeft] = useState<Skipped[]>([]);
  const roleName = (r: string) => (en.assemblies.roles as Record<string, string>)[r] ?? r;

  async function run(replace: boolean) {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/jobs/${jobId}/scopes/from-measurements`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ division: "roofing", wastePct: Number(waste), replace }),
    }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string; tiers?: unknown[]; skipped?: Skipped[] };
    setBusy(false);
    if (res?.ok) {
      setNeedsReplace(false);
      setLeft((out.skipped ?? []).filter((s) => s.reason !== "not_needed"));
      setMsg({ ok: true, text: e.built(out.tiers?.length ?? 0) });
      setTimeout(() => window.location.reload(), 1200);
      return;
    }
    if (out.error === "scope_exists") { setNeedsReplace(true); return; }
    setLeft(out.skipped ?? []);
    setMsg({ ok: false, text: (e.errors as Record<string, string>)[res?.status === 429 ? "rate_limited" : out.error ?? ""] ?? e.errors.generic });
  }

  return (
    <div className="noprint">
      <h3 className="small-heading">{e.buildTitle}</h3>
      <p className="muted small-text">{e.buildHelp}</p>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      <p>
        <label>{e.waste}{" "}
          <select value={waste} onChange={(ev) => setWaste(ev.target.value)}>
            {[0, 5, 10, 15, 20].map((w) => <option key={w} value={w}>{w}%</option>)}
          </select>
        </label>{" "}
        <button type="button" disabled={busy} onClick={() => run(false)}>{e.build}</button>
      </p>
      {needsReplace && (
        <p className="warn">
          {e.replaceWarn}{" "}
          <button type="button" disabled={busy} onClick={() => run(true)}>{e.replace}</button>
        </p>
      )}
      {left.length > 0 && (
        <div className="small-text">
          <p className="muted">{e.leftOut(left.length)}</p>
          <ul className="list">
            {left.map((s, i) => <li key={i}>{(en.assemblies.tiers as Record<string, string>)[s.tier] ?? s.tier}: {roleName(s.role)} ({(e.skipReason as Record<string, string>)[s.reason] ?? s.reason})</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}