"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";
import type { ProductionView, TradeView } from "@/lib/production/logic.ts";

const tradeName = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;
const errText = (code?: string) => (en.production.errors as Record<string, string>)[code ?? ""] ?? en.production.errors.generic;
type Msg = { ok: boolean; text: string } | null;

export function ProductionClient({ view }: { view: ProductionView }) {
  const router = useRouter();
  const jobId = view.job.id;
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; out: Record<string, unknown> }> {
    setBusy(true);
    setMsg(null);
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(false);
    if (!res.ok) setMsg({ ok: false, text: errText(res.status === 429 ? "rate_limited" : (out.error as string | undefined)) });
    return { ok: res.ok, out };
  }

  // ----- colors -----
  const [colors, setColors] = useState<Record<string, string>>(() => Object.fromEntries(view.selectionLines.map((l) => [l.itemId, l.color ?? ""])));
  async function saveColors() {
    const r = await send(`/api/jobs/${jobId}/selections`, "PUT", { items: view.selectionLines.map((l) => ({ itemId: l.itemId, color: colors[l.itemId]?.trim() || null })) });
    if (r.ok) { setMsg({ ok: true, text: en.production.colorsSaved }); router.refresh(); }
  }

  // ----- order -----
  const [po, setPo] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  async function recordOrder() {
    const r = await send(`/api/jobs/${jobId}/materials-order`, "POST", { poReference: po, notes: orderNotes || null });
    if (r.ok) { setMsg({ ok: true, text: en.production.orderRecorded }); setPo(""); router.refresh(); }
  }

  const ordered = view.job.materialsOrdered;
  const gateText = !view.job.contractSigned || !view.job.depositGateMet ? en.production.notReady : null;

  return (
    <div>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      {gateText && <p className="warn">{gateText}</p>}

      {/* Trades */}
      <h2>{en.production.tradesTitle}</h2>
      {view.trades.map((t) => <TradeCard key={t.division} t={t} view={view} send={send} busy={busy} setMsg={setMsg} refresh={() => router.refresh()} />)}

      {/* Materials */}
      {view.materials && (
        <section className="report">
          <div className="report-head">
            <h2>{en.production.materialsTitle}</h2>
            <span className="noprint small-text">
              <a href={`/api/jobs/${jobId}/materials?format=csv`}>{en.production.csv}</a>
            </span>
          </div>
          <p className="muted small-text">{en.production.materialsNote}</p>
          {view.materials.missingColors > 0 && <p className="warn small-text">{en.production.missingColors(view.materials.missingColors)}</p>}
          {view.materials.sections.map((s) => (
            <div key={s.division}>
              <h3 className="small-heading">{tradeName(s.division)}: {s.packageTitle}</h3>
              <table className="lines">
                <thead>
                  <tr><th>{en.production.colItem}</th><th>{en.production.colColor}</th><th className="num">{en.production.colQty}</th><th>{en.production.colUnit}</th><th /></tr>
                </thead>
                <tbody>
                  {s.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.description}</td>
                      <td>{l.color ?? <span className="muted">{en.production.noColor}</span>}</td>
                      <td className="num">{l.quantity}</td><td>{l.unit}</td>
                      <td>{l.specialOrder && <span className="badge">{en.production.special}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <p className="noprint"><button type="button" className="secondary small" onClick={() => window.print()}>{en.production.print}</button></p>
        </section>
      )}

      {/* Colors (estimator and admin, before the order) */}
      {view.rights.canEditSelections && view.selectionLines.length > 0 && (
        <div className="panel noprint">
          <h2>{en.production.colorsTitle}</h2>
          <p className="muted small-text">{en.production.colorsHelp}</p>
          <table className="lines">
            <tbody>
              {view.selectionLines.map((l) => (
                <tr key={l.itemId}>
                  <td>{tradeName(l.division)}</td><td>{l.description}</td><td className="num">{l.quantity} {l.unit}</td>
                  <td>
                    <input aria-label={`${l.description} ${en.production.colColor}`} placeholder={en.production.colorPlaceholder} maxLength={60}
                      value={colors[l.itemId] ?? ""} onChange={(e) => setColors((c) => ({ ...c, [l.itemId]: e.target.value }))} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row"><button onClick={saveColors} disabled={busy}>{en.production.saveColors}</button></div>
        </div>
      )}

      {/* Order (estimator and admin) */}
      {view.rights.canViewAll && (
        <div className="panel noprint">
          <h2>{en.production.orderTitle}</h2>
          {ordered ? (
            <p className="ok">{en.production.orderedOn(ordered.at.slice(0, 10), ordered.poReference)}</p>
          ) : view.rights.canOrderMaterials ? (
            <>
              <p className="muted small-text">{en.production.poHelp}</p>
              <label htmlFor="po">{en.production.poLabel}</label>
              <input id="po" value={po} maxLength={60} onChange={(e) => setPo(e.target.value)} />
              <label htmlFor="po-notes">{en.production.orderNotes}</label>
              <input id="po-notes" value={orderNotes} maxLength={300} onChange={(e) => setOrderNotes(e.target.value)} />
              <div className="row"><button onClick={recordOrder} disabled={busy || po.trim() === ""}>{busy ? en.production.ordering : en.production.recordOrder}</button></div>
            </>
          ) : <p className="muted">{gateText ?? ""}</p>}
        </div>
      )}
    </div>
  );
}

function TradeCard(props: {
  t: TradeView; view: ProductionView; busy: boolean; refresh: () => void; setMsg: (m: Msg) => void;
  send: (url: string, method: string, body: unknown) => Promise<{ ok: boolean; out: Record<string, unknown> }>;
}) {
  const { t, view, send, busy, setMsg, refresh } = props;
  const [date, setDate] = useState(t.installDate ?? "");
  const [crew, setCrew] = useState(t.crewLeaderId ?? "");
  const url = `/api/jobs/${view.job.id}/production/${t.division}`;
  const r = t.rights;

  async function act(body: Record<string, unknown>) {
    const res = await send(url, "POST", body);
    if (!res.ok) return;
    const conflicts = (res.out.conflicts as { jobNumber: number; division: string }[] | undefined) ?? [];
    const crewName = view.crewLeaders.find((c) => c.id === crew)?.fullName ?? "That crew leader";
    setMsg(conflicts.length
      ? { ok: false, text: en.production.conflict(crewName, conflicts.map((c) => `job ${c.jobNumber} (${tradeName(c.division)})`).join(", ")) }
      : { ok: true, text: en.production.saved });
    refresh();
  }

  return (
    <div className="panel">
      <h2>{tradeName(t.division)} <span className="badge">{en.production.status[t.status]}</span></h2>
      <dl>
        <div><dt>{en.production.installDate}</dt><dd>{t.installDate ?? "-"}</dd></div>
        <div><dt>{en.production.crewLeader}</dt><dd>{t.crewLeaderName ?? <span className="muted">{en.production.noCrew}</span>}</dd></div>
      </dl>

      {(r.canPropose || r.canConfirm) && (
        <div className="row noprint">
          <label htmlFor={`d-${t.division}`}>{en.production.installDate}</label>
          <input id={`d-${t.division}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {r.canConfirm && (
            <select aria-label={en.production.crewLeader} value={crew} onChange={(e) => setCrew(e.target.value)}>
              <option value="">{en.production.pickCrew}</option>
              {view.crewLeaders.map((c) => <option key={c.id} value={c.id}>{c.fullName}</option>)}
            </select>
          )}
        </div>
      )}
      <div className="row noprint">
        {r.canPropose && !r.canConfirm && (
          <button className="secondary small" disabled={busy || !date} onClick={() => act({ action: "propose", installDate: date })}>{en.production.propose}</button>
        )}
        {r.canConfirm && (
          <button className="small" disabled={busy || !crew || !date} onClick={() => act({ action: "confirm", installDate: date, crewLeaderId: crew })}>
            {t.status === "scheduled" ? en.production.reschedule : en.production.confirm}
          </button>
        )}
        {r.canStart && <button className="small" disabled={busy} onClick={() => act({ action: "start" })}>{en.production.start}</button>}
        {r.canComplete && <button className="small" disabled={busy} onClick={() => act({ action: "complete" })}>{en.production.complete}</button>}
      </div>
      {!view.job.materialsOrdered && t.status === "proposed" && !r.canConfirm && view.rights.canViewAll && (
        <p className="muted small-text">{en.production.waitingForOrder}</p>
      )}
    </div>
  );
}
