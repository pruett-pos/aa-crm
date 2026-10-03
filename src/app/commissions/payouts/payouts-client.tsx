"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { en } from "@/i18n/en.ts";
import type { PayoutRow } from "@/lib/commission/logic.ts";

const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const errText = (code?: string) => (en.commission.errors as Record<string, string>)[code ?? ""] ?? en.commission.errors.generic;
type Msg = { ok: boolean; text: string } | null;

export function PayoutsClient(props: {
  hasSchedule: boolean; rows: PayoutRow[]; uncommissioned: number;
  estimators: { id: string; fullName: string }[]; canAdjust: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const [drawEst, setDrawEst] = useState(props.estimators[0]?.id ?? "");
  const [drawAmount, setDrawAmount] = useState("");
  const [drawDate, setDrawDate] = useState("");
  const [drawNote, setDrawNote] = useState("");

  const [adjEst, setAdjEst] = useState(props.estimators[0]?.id ?? "");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");

  async function post(url: string, body: unknown): Promise<{ ok: boolean; out: { error?: string; run?: { netCents: number } } }> {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => ({}))) as { error?: string; run?: { netCents: number } };
    return { ok: res.ok, out: res.status === 429 ? { error: "rate_limited" } : out };
  }

  async function pay(row: PayoutRow) {
    if (!window.confirm(en.commission.confirmPay(row.estimatorName, money(row.netCents)))) return;
    setBusy(row.estimatorId);
    setMsg(null);
    const r = await post("/api/commissions/runs", { estimatorId: row.estimatorId, periodEnd: row.period.end });
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: errText(r.out.error) });
    setMsg({ ok: true, text: en.commission.paid(money(r.out.run?.netCents ?? 0)) });
    router.refresh();
  }

  async function submitDraw(e: FormEvent) {
    e.preventDefault();
    setBusy("draw");
    setMsg(null);
    const r = await post("/api/commissions/draws", { estimatorId: drawEst, amount: drawAmount, paidOn: drawDate || undefined, note: drawNote || undefined });
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: errText(r.out.error) });
    setMsg({ ok: true, text: en.commission.drawRecorded });
    setDrawAmount(""); setDrawNote(""); setDrawDate("");
    router.refresh();
  }

  async function submitAdjust(e: FormEvent) {
    e.preventDefault();
    setBusy("adjust");
    setMsg(null);
    const r = await post("/api/commissions/adjustments", { estimatorId: adjEst, amount: adjAmount, reason: adjReason });
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: errText(r.out.error) });
    setMsg({ ok: true, text: en.commission.adjustRecorded });
    setAdjAmount(""); setAdjReason("");
    router.refresh();
  }

  return (
    <div>
      {props.uncommissioned > 0 && <p className="warn">{en.commission.uncommissioned(props.uncommissioned)}</p>}
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}

      {!props.hasSchedule ? (
        <p className="warn">{en.commission.needSchedule}</p>
      ) : (
        <table className="lines">
          <thead>
            <tr>
              <th>{en.commission.colEstimator}</th><th>{en.commission.colPeriod}</th><th>{en.commission.colEarned}</th>
              <th>{en.commission.colDraws}</th><th>{en.commission.colNet}</th><th />
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.estimatorId}>
                <td>{r.estimatorName}</td>
                <td>{r.period.start} to {r.period.end}</td>
                <td className={r.unpaidThroughCents < 0 ? "warn" : ""}>{money(r.unpaidThroughCents)}</td>
                <td>{money(r.drawsOutstandingCents)}</td>
                <td><strong>{money(r.netCents)}</strong></td>
                <td>
                  {r.alreadyPaid ? <span className="muted">{en.commission.alreadyPaid}</span>
                    : r.canPay ? <button className="small" disabled={busy !== null} onClick={() => pay(r)}>{busy === r.estimatorId ? en.commission.paying : en.commission.pay}</button>
                    : <span className="muted">{en.commission.nothingToPay}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={submitDraw} className="panel">
        <h2>{en.commission.drawForm}</h2>
        <div className="grid3">
          <div>
            <label htmlFor="draw-est">{en.commission.colEstimator}</label>
            <select id="draw-est" value={drawEst} onChange={(e) => setDrawEst(e.target.value)}>
              {props.estimators.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
            </select>
          </div>
          <div><label htmlFor="draw-amt">{en.commission.amount}</label><input id="draw-amt" inputMode="decimal" value={drawAmount} onChange={(e) => setDrawAmount(e.target.value)} required /></div>
          <div><label htmlFor="draw-date">{en.commission.date}</label><input id="draw-date" type="date" value={drawDate} onChange={(e) => setDrawDate(e.target.value)} /></div>
        </div>
        <label htmlFor="draw-note">{en.commission.note}</label>
        <input id="draw-note" value={drawNote} onChange={(e) => setDrawNote(e.target.value)} maxLength={300} />
        <div className="row"><button type="submit" disabled={busy !== null}>{en.commission.recordDraw}</button></div>
      </form>

      {props.canAdjust && (
        <form onSubmit={submitAdjust} className="panel">
          <h2>{en.commission.adjustForm}</h2>
          <p className="muted small-text">{en.commission.adjustHelp}</p>
          <div className="grid2">
            <div>
              <label htmlFor="adj-est">{en.commission.colEstimator}</label>
              <select id="adj-est" value={adjEst} onChange={(e) => setAdjEst(e.target.value)}>
                {props.estimators.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
              </select>
            </div>
            <div><label htmlFor="adj-amt">{en.commission.amount}</label><input id="adj-amt" inputMode="decimal" value={adjAmount} onChange={(e) => setAdjAmount(e.target.value)} required /></div>
          </div>
          <label htmlFor="adj-reason">{en.commission.reason}</label>
          <input id="adj-reason" value={adjReason} onChange={(e) => setAdjReason(e.target.value)} maxLength={300} required />
          <div className="row"><button type="submit" disabled={busy !== null}>{en.commission.recordAdjust}</button></div>
        </form>
      )}
    </div>
  );
}
