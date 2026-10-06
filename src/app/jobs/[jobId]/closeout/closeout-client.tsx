"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";
import type { CloseoutView, InvoiceView, ItemView } from "@/lib/closeout/logic.ts";
import { STAGES } from "@/lib/rules.ts";

const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
// Fixed time zone so the server and the browser print the same text.
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric" });
const tradeName = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;
const errText = (code?: string) => (en.closeout.errors as Record<string, string>)[code ?? ""] ?? en.closeout.errors.generic;
type Msg = { ok: boolean; text: string } | null;

export function CloseoutClient({ view }: { view: CloseoutView }) {
  const router = useRouter();
  const jobId = view.job.id;
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; out: Record<string, unknown> }> {
    setBusy(true);
    setMsg(null);
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    setBusy(false);
    if (!res || !res.ok) setMsg({ ok: false, text: errText(res?.status === 429 ? "rate_limited" : (out.error as string | undefined)) });
    return { ok: !!res?.ok, out };
  }
  const done = (text: string) => { setMsg({ ok: true, text }); router.refresh(); };

  return (
    <div>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      <Punchlist view={view} send={send} busy={busy} done={done} jobId={jobId} />
      {view.invoice && <InvoicePanel view={view} send={send} busy={busy} done={done} jobId={jobId} />}
    </div>
  );
}

type Send = (url: string, method: string, body?: unknown) => Promise<{ ok: boolean; out: Record<string, unknown> }>;

// ---------- Punchlist ----------
function Punchlist({ view, send, busy, done, jobId }: { view: CloseoutView; send: Send; busy: boolean; done: (t: string) => void; jobId: string }) {
  const groups = new Map<string, ItemView[]>();
  for (const i of view.items) groups.set(i.division ?? "", [...(groups.get(i.division ?? "") ?? []), i]);
  const order = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));

  async function tick(i: ItemView) {
    const r = await send(`/api/jobs/${jobId}/punchlist/${i.id}`, "PATCH", { done: !i.done });
    if (r.ok) done("");
  }
  async function start() {
    const r = await send(`/api/jobs/${jobId}/punchlist`, "POST", { action: "start" });
    if (r.ok) done(en.closeout.started);
  }

  return (
    <section className="report">
      <div className="report-head">
        <h2>{en.closeout.punchlistTitle}</h2>
        {view.progress.total > 0 && <span className="small-text muted">{en.closeout.progress(view.progress.done, view.progress.total)}</span>}
      </div>
      {view.items.length === 0 && (
        view.canStart ? (
          <p>
            <button type="button" disabled={busy} onClick={start}>{en.closeout.startList}</button>{" "}
            <span className="muted small-text">{en.closeout.startHint}</span>
          </p>
        ) : (
          <p className="muted">{STAGES.indexOf(view.job.stage as (typeof STAGES)[number]) >= STAGES.indexOf("closeout_punchlist") ? en.closeout.noItems : en.closeout.notStarted}</p>
        )
      )}
      {!view.editable && view.items.length > 0 && <p className="muted small-text">{en.closeout.locked}</p>}
      {order.map((key) => (
        <div key={key || "job"}>
          <h3 className="small-heading">{key === "" ? en.closeout.wholeJob : tradeName(key)}</h3>
          <ul className="list">
            {(groups.get(key) ?? []).map((i) => <Item key={i.id} item={i} busy={busy} onTick={() => tick(i)} send={send} done={done} jobId={jobId} />)}
          </ul>
        </div>
      ))}
      {view.canAdd && <AddItem canAdd={view.canAdd} send={send} busy={busy} done={done} jobId={jobId} />}
    </section>
  );
}

function Item({ item: i, busy, onTick, send, done, jobId }: { item: ItemView; busy: boolean; onTick: () => void; send: Send; done: (t: string) => void; jobId: string }) {
  const [editing, setEditing] = useState(false);
  const [en_, setEn] = useState(i.labelEn);
  const [ru, setRu] = useState(i.labelRu ?? "");

  async function save() {
    const r = await send(`/api/jobs/${jobId}/punchlist/${i.id}`, "PATCH", { labelEn: en_, labelRu: ru.trim() === "" ? null : ru });
    if (r.ok) { setEditing(false); done(""); }
  }
  async function remove() {
    if (!window.confirm(en.closeout.removeConfirm)) return;
    const r = await send(`/api/jobs/${jobId}/punchlist/${i.id}`, "DELETE");
    if (r.ok) done("");
  }

  if (editing) {
    return (
      <li>
        <input value={en_} maxLength={200} onChange={(e) => setEn(e.target.value)} aria-label={en.closeout.addLabel} />{" "}
        <input value={ru} maxLength={200} onChange={(e) => setRu(e.target.value)} aria-label={en.closeout.addRuLabel} placeholder={en.closeout.addRuLabel} />{" "}
        <button type="button" className="small" disabled={busy} onClick={save}>{en.closeout.save}</button>{" "}
        <button type="button" className="secondary small" disabled={busy} onClick={() => { setEditing(false); setEn(i.labelEn); setRu(i.labelRu ?? ""); }}>{en.closeout.cancel}</button>
      </li>
    );
  }
  return (
    <li>
      <label className="check">
        <input type="checkbox" checked={i.done} disabled={busy || !i.canTick} onChange={onTick} /> <span>{i.labelEn}</span>
      </label>
      {i.labelRu && <div className="muted small-text"><span>{en.closeout.ruTag}</span> {i.labelRu}</div>}
      {i.canEdit && (
        <span className="noprint">
          {" "}<button type="button" className="secondary small" disabled={busy} onClick={() => setEditing(true)}>{en.closeout.rename}</button>
          {" "}<button type="button" className="secondary small" disabled={busy} onClick={remove}>{en.closeout.remove}</button>
        </span>
      )}
    </li>
  );
}

function AddItem({ canAdd, send, busy, done, jobId }: { canAdd: NonNullable<CloseoutView["canAdd"]>; send: Send; busy: boolean; done: (t: string) => void; jobId: string }) {
  const [target, setTarget] = useState(canAdd.wholeJob ? "" : canAdd.divisions[0] ?? "");
  const [label, setLabel] = useState("");
  const [ru, setRu] = useState("");

  async function add() {
    const r = await send(`/api/jobs/${jobId}/punchlist`, "POST", { action: "add", division: target === "" ? null : target, labelEn: label, labelRu: ru.trim() === "" ? null : ru });
    if (r.ok) { setLabel(""); setRu(""); done(en.closeout.added); }
  }
  return (
    <details className="noprint">
      <summary>{en.closeout.addItem}</summary>
      <p>
        <label>{en.closeout.addTo}{" "}
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {canAdd.wholeJob && <option value="">{en.closeout.wholeJob}</option>}
            {canAdd.divisions.map((d) => <option key={d} value={d}>{tradeName(d)}</option>)}
          </select>
        </label>
      </p>
      <p><label>{en.closeout.addLabel}<br /><input value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} /></label></p>
      <p><label>{en.closeout.addRuLabel}<br /><input value={ru} maxLength={200} onChange={(e) => setRu(e.target.value)} /></label></p>
      <button type="button" disabled={busy || label.trim() === ""} onClick={add}>{en.closeout.add}</button>
    </details>
  );
}

// ---------- Invoice ----------
function InvoicePanel({ view, send, busy, done, jobId }: {
  view: CloseoutView; send: Send; busy: boolean; done: (t: string) => void; jobId: string;
}) {
  const router = useRouter();
  const inv = view.invoice!;
  const [to, setTo] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");

  async function issue() {
    const r = await send(`/api/jobs/${jobId}/invoice`, "POST", { action: "issue" });
    if (!r.ok) return;
    const n = r.out.invoiceNumber as number;
    done(`${en.closeout.issued(n)} ${r.out.stage === "paid_in_full" ? en.closeout.paidMoved : en.closeout.stageMoved}`);
  }
  async function email() {
    const r = await send(`/api/jobs/${jobId}/invoice`, "POST", { action: "send", to: to.trim() === "" ? null : to.trim() });
    if (r.ok) { setTo(""); done(en.closeout.sent(r.out.to as string)); }
    else router.refresh();
  }
  async function voidIt() {
    const r = await send(`/api/jobs/${jobId}/invoice`, "POST", { action: "void", reason });
    if (r.ok) { setVoiding(false); setReason(""); done(en.closeout.voided); }
  }

  const live = inv.live;
  const gateText = !inv.gate.ok && inv.gate.reason !== "invoice_exists" ? en.closeout.gate[inv.gate.reason] : null;

  return (
    <section className="report">
      <h2>{en.closeout.invoiceTitle}</h2>
      <dl>
        <div><dt>{en.closeout.contractTotal}</dt><dd>{money(inv.contractCents)}</dd></div>
        <div><dt>{en.closeout.collected}</dt><dd>{money(inv.collectedCents)}</dd></div>
        <div><dt>{en.closeout.balanceDue}</dt><dd>{money(inv.balanceCents)}</dd></div>
      </dl>
      <p className="muted small-text">{en.closeout.terms}</p>

      {live ? (
        <LiveInvoice live={live} />
      ) : view.job.stage === "paid_in_full" ? (
        <p className="ok">{en.closeout.paidInFull}</p>
      ) : inv.canManage ? (
        inv.gate.ok ? (
          <p>
            <span className="ok">{en.closeout.ready}</span>{" "}
            <button type="button" disabled={busy} onClick={issue}>{en.closeout.issue}</button>
          </p>
        ) : gateText ? <p className="warn">{gateText}</p> : null
      ) : gateText ? <p className="muted">{gateText}</p> : null}

      {live && inv.canManage && (
        <div className="noprint">
          <p>
            <label>{en.closeout.sendTo}{" "}
              <input type="email" value={to} maxLength={254} onChange={(e) => setTo(e.target.value)} placeholder={inv.customerEmail ?? ""} />
            </label>{" "}
            <button type="button" disabled={busy} onClick={email}>{en.closeout.send}</button>
          </p>
          <p className="muted small-text">{en.closeout.sendToHint(inv.customerEmail)}</p>
          {!voiding ? (
            view.job.stage === "invoiced" && <p><button type="button" className="secondary small" disabled={busy} onClick={() => setVoiding(true)}>{en.closeout.void}</button></p>
          ) : (
            <p>
              <label>{en.closeout.voidReason}<br /><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>{" "}
              <button type="button" disabled={busy || reason.trim().length < 3} onClick={voidIt}>{en.closeout.voidConfirm}</button>{" "}
              <button type="button" className="secondary small" disabled={busy} onClick={() => { setVoiding(false); setReason(""); }}>{en.closeout.cancel}</button>
            </p>
          )}
        </div>
      )}

      {inv.history.length > 0 && (
        <>
          <h3 className="small-heading">{en.closeout.voidedTitle}</h3>
          <ul className="list">
            {inv.history.map((h) => (
              <li key={h.id} className="muted">
                {en.closeout.invoiceNumber(h.invoiceNumber)} · {en.closeout.issuedOn(day(h.issuedAt))} · {en.closeout.voidedBecause(h.voidReason ?? "")}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function LiveInvoice({ live }: { live: InvoiceView }) {
  return (
    <div>
      <p>
        <strong>{en.closeout.invoiceNumber(live.invoiceNumber)}</strong> · {en.closeout.issuedOn(day(live.issuedAt))} · {en.closeout.owedAtIssue(money(live.balanceCents))}{" "}
        <a href={`/api/invoices/${live.id}/pdf`} target="_blank" rel="noopener noreferrer">{en.closeout.downloadPdf}</a>
      </p>
      <p className="small-text muted">
        {live.emailStatus === "sent" && live.emailedTo && live.emailedAt ? en.closeout.lastSent(live.emailedTo, day(live.emailedAt))
          : live.emailStatus === "failed" ? en.closeout.lastFailed : en.closeout.notEmailed}
      </p>
    </div>
  );
}
