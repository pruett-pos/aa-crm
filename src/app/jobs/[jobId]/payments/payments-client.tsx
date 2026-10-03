"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { en } from "@/i18n/en.ts";
import type { Role } from "@/lib/auth/roles.ts";
import type { PaymentSummary } from "@/lib/payments/logic.ts";
import { METHODS, type Method, type PaymentType } from "@/lib/payments/types.ts";

type Row = {
  id: string; amountCents: number; method: Method; reference: string | null; notes: string | null;
  receivedAt: string; voidedAt: string | null; voidReason: string | null; hasPhoto: boolean;
  isDeposit: boolean; isDepreciation: boolean;
};

const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const errText = (code?: string) => (en.payments.errors as Record<string, string>)[code ?? ""] ?? en.payments.errors.generic;

export function PaymentsClient(props: {
  jobId: string; isInsurance: boolean; role: Role; canVoid: boolean; summary: PaymentSummary;
  commissionEarnedCents: number | null; payments: Row[];
}) {
  const { jobId, summary: s, payments, canVoid, role } = props;
  const router = useRouter();

  const [type, setType] = useState<PaymentType>(s.depositDueCents > 0 ? "deposit" : "payment");
  const [method, setMethod] = useState<Method>("check");
  const [amount, setAmount] = useState(s.depositDueCents > 0 ? (s.depositDueCents / 100).toFixed(2) : "");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const needsPhoto = method === "check" && role === "estimator";
  const refHint = method === "card" ? en.payments.referenceHintCard : method === "check" ? en.payments.referenceHintCheck : en.payments.referenceHintOther;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const fd = new FormData();
    fd.set("amount", amount); fd.set("type", type); fd.set("method", method);
    fd.set("reference", reference); fd.set("notes", notes);
    if (photo) fd.set("photo", photo);
    const res = await fetch(`/api/jobs/${jobId}/payments`, { method: "POST", body: fd });
    const body = (await res.json().catch(() => ({}))) as { error?: string; stageChanged?: boolean };
    setBusy(false);
    if (!res.ok) return setMessage({ kind: "error", text: errText(res.status === 429 ? "rate_limited" : res.status === 403 ? "forbidden" : body.error) });
    setMessage({ kind: "ok", text: body.stageChanged ? `${en.payments.recorded} ${en.payments.stageMoved}` : en.payments.recorded });
    setAmount(""); setReference(""); setNotes(""); setPhoto(null);
    setFileKey((k) => k + 1); // clears the file picker
    router.refresh();
  }

  async function confirmVoid(id: string) {
    setBusy(true);
    const res = await fetch(`/api/payments/${id}/void`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: voidReason }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; depositNoLongerCovered?: boolean };
    setBusy(false);
    if (!res.ok) return setMessage({ kind: "error", text: errText(body.error) });
    setVoidingId(null); setVoidReason("");
    setMessage({ kind: body.depositNoLongerCovered ? "error" : "ok", text: body.depositNoLongerCovered ? en.payments.voidedWarning : en.payments.voidedOk });
    router.refresh();
  }

  return (
    <div>
      <div className="panel">
        <dl>
          <div><dt>{en.payments.contract}</dt><dd>{money(s.contractCents)}</dd></div>
          <div><dt>{en.payments.depositRequired}</dt><dd>{money(s.depositRequiredCents)}</dd></div>
          <div><dt>{en.payments.depositDue}</dt><dd>{money(s.depositDueCents)}</dd></div>
          <div><dt>{en.payments.collected}</dt><dd>{money(s.collectedCents)}</dd></div>
          <div><dt>{en.payments.balance}</dt><dd>{money(s.balanceDueCents)}</dd></div>
          {props.commissionEarnedCents !== null && (
            <div><dt>{en.payments.commissionEarned}</dt><dd>{money(props.commissionEarnedCents)}</dd></div>
          )}
        </dl>
        {s.depositRequiredCents > 0 && (
          <p className={s.depositCovered ? "muted" : "warn"}>{s.depositCovered ? en.payments.depositCovered : en.payments.depositNotCovered}</p>
        )}
      </div>

      {message && <p className={message.kind === "ok" ? "ok" : "error"} role="status">{message.text}</p>}

      <form onSubmit={submit} className="panel">
        <h2>{en.payments.form}</h2>
        <div className="grid3">
          <div>
            <label htmlFor="amount">{en.payments.amount}</label>
            <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="type">{en.payments.type}</label>
            <select id="type" value={type} onChange={(e) => setType(e.target.value as PaymentType)}>
              <option value="deposit">{en.payments.types.deposit}</option>
              <option value="payment">{en.payments.types.payment}</option>
              {props.isInsurance && <option value="depreciation">{en.payments.types.depreciation}</option>}
            </select>
          </div>
          <div>
            <label htmlFor="method">{en.payments.method}</label>
            <select id="method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {METHODS.map((m) => <option key={m} value={m}>{en.payments.methods[m]}</option>)}
            </select>
          </div>
        </div>
        <label htmlFor="reference">{en.payments.reference} <span className="muted">({refHint})</span></label>
        <input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        {method === "card" && <p className="muted small-text">{en.payments.cardNote}</p>}
        {(method === "check" || method === "insurance_check") && (
          <>
            <label htmlFor="photo">{en.payments.photo}{needsPhoto ? " *" : ""}</label>
            <input key={fileKey} id="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </>
        )}
        <label htmlFor="notes">{en.payments.notes}</label>
        <input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        <div className="row">
          <button type="submit" disabled={busy || (needsPhoto && !photo)}>{busy ? en.payments.submitting : en.payments.submit}</button>
          {needsPhoto && !photo && <span className="muted small-text">{en.payments.photoNeeded}</span>}
        </div>
      </form>

      <h2>{en.payments.history}</h2>
      {payments.length === 0 ? (
        <p className="muted">{en.payments.none}</p>
      ) : (
        <table className="lines">
          <thead>
            <tr><th>{en.payments.colDate}</th><th>{en.payments.colAmount}</th><th>{en.payments.colMethod}</th><th>{en.payments.colRef}</th><th>{en.payments.colBy}</th></tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className={p.voidedAt ? "voided" : ""}>
                <td>{p.receivedAt.slice(0, 10)}</td>
                <td>{money(p.amountCents)}{p.isDeposit ? ` (${en.payments.types.deposit.toLowerCase()})` : p.isDepreciation ? " (depreciation)" : ""}</td>
                <td>{en.payments.methods[p.method]}</td>
                <td>
                  {p.reference ?? ""}
                  {p.hasPhoto && <> <a href={`/api/payments/${p.id}/photo`} target="_blank" rel="noreferrer">{en.payments.viewPhoto}</a></>}
                </td>
                <td>
                  {p.voidedAt ? <span className="muted">{en.payments.voided}: {p.voidReason}</span> : canVoid && (
                    voidingId === p.id ? (
                      <span className="row">
                        <input aria-label={en.payments.voidReason} placeholder={en.payments.voidReason} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                        <button className="small" disabled={busy} onClick={() => confirmVoid(p.id)}>{en.payments.voidConfirm}</button>
                        <button className="secondary small" onClick={() => { setVoidingId(null); setVoidReason(""); }}>{en.payments.cancel}</button>
                      </span>
                    ) : <button className="secondary small" onClick={() => setVoidingId(p.id)}>{en.payments.void}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
