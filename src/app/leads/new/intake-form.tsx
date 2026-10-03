"use client";

import { useState, type FormEvent } from "react";
import { en } from "@/i18n/en.ts";
import { DIVISIONS, LEAD_SOURCES, MARKETS, type CustomerHit } from "@/lib/leads/types.ts";
import type { Division } from "@/lib/rules.ts";

const errText = (code?: string) => (en.leads.errors as Record<string, string>)[code ?? ""] ?? en.leads.errors.generic;

type Result = { jobNumber: number; via: "override" | "last_estimator" | "division_pm" | "none" };

export function IntakeForm({ estimators }: { estimators: { id: string; fullName: string }[] }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [propertyId, setPropertyId] = useState<string | "new">("new");
  const [person, setPerson] = useState({ firstName: "", lastName: "", phone: "", email: "" });
  const [address, setAddress] = useState({ street: "", city: "", state: "MO", zip: "" });
  const [market, setMarket] = useState<string>("west_plains");
  const [jobType, setJobType] = useState<"retail" | "insurance">("retail");
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [source, setSource] = useState<string>("phone");
  const [appointment, setAppointment] = useState("");
  const [override, setOverride] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const selected = hits?.find((h) => h.id === customerId) ?? null;

  async function search(e: FormEvent) {
    e.preventDefault();
    setSearchError(null);
    const res = await fetch(`/api/customers/search?q=${encodeURIComponent(q)}`);
    const body = (await res.json().catch(() => ({}))) as { customers?: CustomerHit[]; error?: string };
    if (!res.ok) return setSearchError(errText(res.status === 429 ? "rate_limited" : body.error));
    setHits(body.customers ?? []);
    setCustomerId(null);
  }

  function pickCustomer(h: CustomerHit) {
    setCustomerId(h.id);
    const first = h.properties[0];
    setPropertyId(first ? first.id : "new");
    if (first) setMarket(first.market);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      customer: customerId ? { existingId: customerId } : person,
      property: customerId && propertyId !== "new" ? { existingId: propertyId } : address,
      market, jobType, divisions, source,
      appointmentAt: appointment ? new Date(appointment).toISOString() : null,
      overrideEstimatorId: override || null,
    };
    const res = await fetch("/api/leads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => ({}))) as { error?: string; jobNumber?: number; route?: { via: Result["via"] } };
    setBusy(false);
    if (!res.ok) return setError(errText(res.status === 429 ? "rate_limited" : out.error));
    setResult({ jobNumber: out.jobNumber ?? 0, via: out.route?.via ?? "none" });
  }

  if (result) {
    const how = { last_estimator: en.leads.routedEstimator, division_pm: en.leads.routedPm, override: en.leads.routedOverride, none: en.leads.routedNone }[result.via];
    return (
      <div className="panel">
        <h2>{en.leads.createdLead(result.jobNumber)}</h2>
        <p className={result.via === "none" ? "warn" : "ok"}>{how}</p>
        <p><a className="btn-link" href="/leads/new">{en.leads.another}</a></p>
      </div>
    );
  }

  const toggle = (d: Division) => setDivisions((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  const canSubmit = divisions.length > 0 && !busy;

  return (
    <div>
      <form onSubmit={search} className="panel">
        <h2>{en.leads.searchTitle}</h2>
        <label htmlFor="q">{en.leads.searchLabel}</label>
        <input id="q" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        <p className="muted small-text">{en.leads.searchHint}</p>
        <button type="submit">{en.leads.searchButton}</button>
        {searchError && <p className="error">{searchError}</p>}
        {hits && hits.length === 0 && <p className="muted">{en.leads.noMatches}</p>}
        {hits && hits.length > 0 && (
          <ul className="list">
            {hits.map((h) => (
              <li key={h.id}>
                <strong>{h.firstName} {h.lastName}</strong> <span className="muted">{h.phone ?? h.email ?? ""}</span>
                <div className="muted small-text">
                  {h.properties.map((p) => `${p.street}, ${p.city}${p.jobs.length ? ` (job ${p.jobs.map((j) => j.jobNumber).join(", ")})` : ""}`).join(" | ")}
                </div>
                <button type="button" className={h.id === customerId ? "small" : "secondary small"} onClick={() => pickCustomer(h)}>
                  {h.id === customerId ? `${en.leads.useCustomer} ✓` : en.leads.useCustomer}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>

      <form onSubmit={submit} className="panel">
        {selected ? (
          <>
            <h2>{selected.firstName} {selected.lastName}</h2>
            <p className="muted">{en.leads.existingNote}</p>
            <label htmlFor="property">{en.leads.pickProperty}</label>
            <select id="property" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              {selected.properties.map((p) => <option key={p.id} value={p.id}>{p.street}, {p.city}</option>)}
              <option value="new">{en.leads.newProperty}</option>
            </select>
            <button type="button" className="secondary small" onClick={() => { setCustomerId(null); setPropertyId("new"); }}>{en.leads.newCustomer}</button>
          </>
        ) : (
          <>
            <h2>{en.leads.newCustomer}</h2>
            <div className="grid2">
              <div><label htmlFor="fn">{en.leads.firstName}</label><input id="fn" value={person.firstName} onChange={(e) => setPerson({ ...person, firstName: e.target.value })} /></div>
              <div><label htmlFor="ln">{en.leads.lastName}</label><input id="ln" value={person.lastName} onChange={(e) => setPerson({ ...person, lastName: e.target.value })} /></div>
              <div><label htmlFor="ph">{en.leads.phone}</label><input id="ph" inputMode="tel" value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} /></div>
              <div><label htmlFor="em">{en.leads.email}</label><input id="em" type="email" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} /></div>
            </div>
          </>
        )}

        {(!selected || propertyId === "new") && (
          <div className="grid2">
            <div><label htmlFor="st">{en.leads.street}</label><input id="st" value={address.street} onChange={(e) => setAddress({ ...address, street: e.target.value })} /></div>
            <div><label htmlFor="ci">{en.leads.city}</label><input id="ci" value={address.city} onChange={(e) => setAddress({ ...address, city: e.target.value })} /></div>
            <div><label htmlFor="sa">{en.leads.state}</label><input id="sa" maxLength={2} value={address.state} onChange={(e) => setAddress({ ...address, state: e.target.value })} /></div>
            <div><label htmlFor="zp">{en.leads.zip}</label><input id="zp" inputMode="numeric" value={address.zip} onChange={(e) => setAddress({ ...address, zip: e.target.value })} /></div>
          </div>
        )}

        <div className="grid3">
          <div>
            <label htmlFor="mk">{en.leads.market}</label>
            <select id="mk" value={market} onChange={(e) => setMarket(e.target.value)}>
              {MARKETS.map((m) => <option key={m} value={m}>{en.leads.markets[m]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="jt">{en.leads.jobType}</label>
            <select id="jt" value={jobType} onChange={(e) => setJobType(e.target.value as "retail" | "insurance")}>
              <option value="retail">{en.leads.jobTypes.retail}</option>
              <option value="insurance">{en.leads.jobTypes.insurance}</option>
            </select>
          </div>
          <div>
            <label htmlFor="so">{en.leads.source}</label>
            <select id="so" value={source} onChange={(e) => setSource(e.target.value)}>
              {LEAD_SOURCES.map((s) => <option key={s} value={s}>{en.leads.sources[s]}</option>)}
            </select>
          </div>
        </div>

        <fieldset className="divisions">
          <legend>{en.leads.divisions}</legend>
          {DIVISIONS.map((d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={divisions.includes(d)} onChange={() => toggle(d)} />
              {en.leads.divisionNames[d]}
            </label>
          ))}
        </fieldset>

        <div className="grid2">
          <div><label htmlFor="ap">{en.leads.appointment}</label><input id="ap" type="datetime-local" value={appointment} onChange={(e) => setAppointment(e.target.value)} /></div>
          <div>
            <label htmlFor="ov">{en.leads.override}</label>
            <select id="ov" value={override} onChange={(e) => setOverride(e.target.value)}>
              <option value="">{en.leads.routeAuto}</option>
              {estimators.map((x) => <option key={x.id} value={x.id}>{x.fullName}</option>)}
            </select>
          </div>
        </div>

        <div className="row">
          <button type="submit" disabled={!canSubmit}>{busy ? en.leads.creating : en.leads.create}</button>
          {error && <span className="error">{error}</span>}
        </div>
      </form>
    </div>
  );
}
