"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";
import { DIVISIONS, MARKETS } from "@/lib/leads/types.ts";
import type { Division } from "@/lib/rules.ts";

type Lead = { jobId: string; jobNumber: number; customerName: string; phone: string | null; address: string; market: string; jobType: string; divisions: Division[] };
const errText = (code?: string) => (en.leads.errors as Record<string, string>)[code ?? ""] ?? en.leads.errors.generic;

function Row({ lead, estimators }: { lead: Lead; estimators: { id: string; fullName: string }[] }) {
  const router = useRouter();
  const [market, setMarket] = useState(lead.market);
  const [jobType, setJobType] = useState(lead.jobType === "insurance" ? "insurance" : "retail");
  const [divisions, setDivisions] = useState<Division[]>(lead.divisions);
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function confirm() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/jobs/${lead.jobId}/confirm-lead`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ market, jobType, divisions, overrideEstimatorId: override || null }),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string; route?: { via: string; needsAssignment: boolean } };
    setBusy(false);
    if (!res.ok) return setMsg({ ok: false, text: errText(out.error) });
    if (out.route?.needsAssignment) setMsg({ ok: false, text: en.leads.routedNone });
    else setMsg({ ok: true, text: en.leads.confirmed });
    router.refresh();
  }

  return (
    <div className="panel">
      <h2>{en.jobs.number} {lead.jobNumber}: {lead.customerName}</h2>
      <p className="muted">{lead.phone ?? ""} · {lead.address}</p>
      <div className="grid3">
        <div>
          <label>{en.leads.market}</label>
          <select value={market} onChange={(e) => setMarket(e.target.value)}>
            {MARKETS.map((m) => <option key={m} value={m}>{en.leads.markets[m]}</option>)}
          </select>
        </div>
        <div>
          <label>{en.leads.jobType}</label>
          <select value={jobType} onChange={(e) => setJobType(e.target.value)}>
            <option value="retail">{en.leads.jobTypes.retail}</option>
            <option value="insurance">{en.leads.jobTypes.insurance}</option>
          </select>
        </div>
        <div>
          <label>{en.leads.override}</label>
          <select value={override} onChange={(e) => setOverride(e.target.value)}>
            <option value="">{en.leads.routeAuto}</option>
            {estimators.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
          </select>
        </div>
      </div>
      <fieldset className="divisions">
        <legend>{en.leads.divisions}</legend>
        {DIVISIONS.map((d) => (
          <label key={d} className="check">
            <input type="checkbox" checked={divisions.includes(d)}
              onChange={() => setDivisions((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))} />
            {en.leads.divisionNames[d]}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button onClick={confirm} disabled={busy || divisions.length === 0}>{busy ? en.leads.confirming : en.leads.confirm}</button>
        {msg && <span className={msg.ok ? "ok" : "error"}>{msg.text}</span>}
      </div>
    </div>
  );
}

export function ReviewList({ leads, estimators }: { leads: Lead[]; estimators: { id: string; fullName: string }[] }) {
  return <>{leads.map((l) => <Row key={l.jobId} lead={l} estimators={estimators} />)}</>;
}
