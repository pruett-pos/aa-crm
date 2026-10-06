"use client";

import { useCallback, useEffect, useState } from "react";
import { en } from "@/i18n/en.ts";
import type { WorkOrderView, WorkOrdersOverview } from "@/lib/workorders/logic.ts";

const tradeName = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;
const errText = (code?: string) => (en.workorders.errors as Record<string, string>)[code ?? ""] ?? en.workorders.errors.generic;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric" });
type Msg = { ok: boolean; text: string } | null;

export function WorkOrderPanel({ jobId }: { jobId: string }) {
  const [data, setData] = useState<WorkOrdersOverview | null>(null);
  const [hidden, setHidden] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/jobs/${jobId}/workorders`).catch(() => null);
    if (res?.ok) { setData((await res.json()) as WorkOrdersOverview); setHidden(false); } else setHidden(true);
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown): Promise<{ ok: boolean; out: Record<string, unknown> }> {
    setBusy(true);
    setMsg(null);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    setBusy(false);
    if (!res?.ok) setMsg({ ok: false, text: errText(res?.status === 429 ? "rate_limited" : (out.error as string | undefined)) });
    return { ok: !!res?.ok, out };
  }
  const ok = async (text: string) => { setMsg({ ok: true, text }); await load(); };

  if (hidden || !data) return null;                  // not allowed to see work orders on this job, or still loading
  if (data.orders.length === 0 && !data.canCreate) return null;

  return (
    <section className="report">
      <h2>{en.workorders.title}</h2>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      {data.canCreate && (
        <p className="noprint">
          <button type="button" disabled={busy} onClick={async () => { const r = await post(`/api/jobs/${jobId}/workorders`, { action: "create" }); if (r.ok) await ok(en.workorders.created((r.out.created as unknown[]).length)); }}>
            {en.workorders.create}
          </button>
        </p>
      )}
      {data.orders.length === 0 && <p className="muted">{en.workorders.none}</p>}
      {data.orders.map((o) => <Order key={o.division} o={o} jobId={jobId} post={post} busy={busy} done={ok} />)}
    </section>
  );
}

type Post = (url: string, body: unknown) => Promise<{ ok: boolean; out: Record<string, unknown> }>;

function Order({ o, jobId, post, busy, done }: { o: WorkOrderView; jobId: string; post: Post; busy: boolean; done: (t: string) => Promise<void> }) {
  const w = en.workorders;
  const url = `/api/jobs/${jobId}/workorders/${o.division}`;
  const [notes, setNotes] = useState(o.notes ?? "");
  const [task, setTask] = useState({ description: "", quantity: "1", unit: "", note: "" });
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  return (
    <div>
      <h3 className="small-heading">
        {tradeName(o.division)} <span className={o.status === "issued" ? "badge" : "badge warn"}>{w.status[o.status]}</span>
        {o.issuedAt && <span className="muted small-text"> · {w.issuedOn(day(o.issuedAt))}</span>}
      </h3>
      <p className="small-text muted">
        {w.installDate}: {o.installDate ?? w.notScheduled} · {w.crewLeader}: {o.crewLeaderName ?? w.notAssigned}
        {" · "}<a href={`/api/jobs/${jobId}/workorders/${o.division}/pdf`} target="_blank" rel="noopener noreferrer">{w.openPdf}</a>
      </p>
      {o.status === "draft" && !o.canEdit && <p className="muted small-text">{w.draftNote}</p>}

      <p className="small-text"><strong>{w.tasks}</strong></p>
      <ul className="list">
        {o.lines.map((l) => (
          <li key={l.id}>
            {l.description} <span className="muted">· {l.quantity} {l.unit}{l.handAdded ? ` · ${w.handAdded}` : ""}</span>
            {l.note && noteFor !== l.id && <div className="muted small-text">{l.note}</div>}
            {o.canEdit && (
              <span className="noprint">
                {" "}<button type="button" className="secondary small" disabled={busy} onClick={() => { setNoteFor(l.id); setNoteText(l.note ?? ""); }}>{w.noteButton}</button>
                {l.handAdded && <>{" "}<button type="button" className="secondary small" disabled={busy} onClick={async () => { const r = await post(url, { action: "remove_task", lineId: l.id }); if (r.ok) await done(""); }}>{w.remove}</button></>}
              </span>
            )}
            {noteFor === l.id && (
              <div className="noprint">
                <input value={noteText} maxLength={300} onChange={(e) => setNoteText(e.target.value)} aria-label={w.taskNote} />{" "}
                <button type="button" disabled={busy} onClick={async () => { const r = await post(url, { action: "task_note", lineId: l.id, note: noteText.trim() === "" ? null : noteText }); if (r.ok) { setNoteFor(null); await done(""); } }}>{w.saveNote}</button>{" "}
                <button type="button" disabled={busy} onClick={() => setNoteFor(null)}>{w.cancel}</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {o.canEdit ? (
        <div className="noprint">
          <p>
            <label>{w.notes}<br /><textarea value={notes} maxLength={1000} rows={3} style={{ width: "100%", boxSizing: "border-box" }} onChange={(e) => setNotes(e.target.value)} /></label><br />
            <button type="button" disabled={busy} onClick={async () => { const r = await post(url, { action: "notes", notes: notes.trim() === "" ? null : notes }); if (r.ok) await done(w.notesSaved); }}>{w.saveNotes}</button>
          </p>
          <details>
            <summary>{w.addTask}</summary>
            <p><label>{w.taskDescription}<br /><input value={task.description} maxLength={200} onChange={(e) => setTask({ ...task, description: e.target.value })} /></label></p>
            <p>
              <label>{w.quantity} <input inputMode="decimal" size={6} value={task.quantity} onChange={(e) => setTask({ ...task, quantity: e.target.value })} /></label>{" "}
              <label>{w.unit} <input size={4} maxLength={8} placeholder="ea" value={task.unit} onChange={(e) => setTask({ ...task, unit: e.target.value })} /></label>
            </p>
            <p><label>{w.taskNote}<br /><input value={task.note} maxLength={300} onChange={(e) => setTask({ ...task, note: e.target.value })} /></label></p>
            <button type="button" disabled={busy || task.description.trim() === ""} onClick={async () => {
              const r = await post(url, { action: "add_task", description: task.description, quantity: task.quantity, unit: task.unit.trim() || null, note: task.note.trim() || null });
              if (r.ok) { setTask({ description: "", quantity: "1", unit: "", note: "" }); await done(""); }
            }}>{w.add}</button>
          </details>
          <p>
            {o.colorsMissing > 0 && <span className="warn">{w.colorsNeeded(o.colorsMissing)} </span>}
            <button type="button" disabled={busy || !o.canIssue} onClick={async () => { const r = await post(url, { action: "issue" }); if (r.ok) await done(w.issued); }}>{w.issue}</button>{" "}
            <span className="muted small-text">{w.issueHint}</span>
          </p>
        </div>
      ) : (
        o.notes && <p className="small-text"><strong>{w.notes}:</strong> {o.notes}</p>
      )}
      {o.canReopen && (
        <p className="noprint">
          <button type="button" className="secondary small" disabled={busy} onClick={async () => { if (!window.confirm(w.reopenConfirm)) return; const r = await post(url, { action: "reopen" }); if (r.ok) await done(w.reopened); }}>{w.reopen}</button>
        </p>
      )}
    </div>
  );
}
