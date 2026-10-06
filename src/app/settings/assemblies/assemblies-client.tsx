"use client";

import { useState } from "react";
import { en } from "@/i18n/en.ts";
import type { AssemblyLine } from "@/lib/estimating/assemblies.ts";

type Product = { id: string; name: string; unit: string };
type MatRole = { role: string; basis: string; per: string; defaultCoverage: number };
type LabRole = { role: string; basis: string; unit: string; label: string };
const TIERS = ["good", "better", "best"] as const;
const errText = (code?: string) => (en.assemblies.errors as Record<string, string>)[code ?? ""] ?? en.assemblies.errors.generic;

type Row = { productId: string; coverage: string; description: string; unit: string; rate: string; enabled: boolean };
const rowFrom = (l: AssemblyLine | undefined): Row => ({
  productId: l?.productId ?? "", coverage: l?.coverage === null || l?.coverage === undefined ? "" : String(l.coverage), description: l?.description ?? "",
  unit: l?.unit ?? "", rate: l?.unitCostCents === null || l?.unitCostCents === undefined ? "" : (l.unitCostCents / 100).toFixed(2), enabled: l?.enabled ?? false,
});

export function AssembliesClient({ lines, products, materialRoles, laborRoles }: { lines: AssemblyLine[]; products: Product[]; materialRoles: MatRole[]; laborRoles: LabRole[] }) {
  const [rows, setRows] = useState<Record<string, Row>>(() => Object.fromEntries(
    TIERS.flatMap((t) => [...materialRoles, ...laborRoles].map((r) => [`${t}:${r.role}`, rowFrom(lines.find((l) => l.tier === t && l.role === r.role))])),
  ));
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const set = (key: string, patch: Partial<Row>) => setRows((x) => ({ ...x, [key]: { ...x[key], ...patch } }));

  async function save(tier: string, role: string, kind: "material" | "labor") {
    const key = `${tier}:${role}`;
    const r = rows[key];
    setBusy(key);
    setMsg((m) => ({ ...m, [key]: { ok: true, text: "" } }));
    const body = kind === "material"
      ? { tier, role, productId: r.productId || null, coverage: r.coverage.trim() === "" ? null : Number(r.coverage), enabled: r.enabled }
      : { tier, role, description: r.description.trim() || null, unit: r.unit.trim() || null, unitCostCents: r.rate.trim() === "" ? null : Math.round(Number(r.rate) * 100), enabled: r.enabled };
    const res = await fetch("/api/settings/assemblies", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as { error?: string; message?: string };
    setBusy(null);
    setMsg((m) => ({ ...m, [key]: res?.ok ? { ok: true, text: en.assemblies.saved } : { ok: false, text: out.message || errText(res?.status === 429 ? "rate_limited" : out.error) } }));
  }

  return (
    <div>
      {TIERS.map((tier) => (
        <section key={tier} className="report">
          <h2>{en.assemblies.tiers[tier]}</h2>
          <h3 className="small-heading">{en.assemblies.material}</h3>
          <table className="lines">
            <thead><tr><th>{en.assemblies.role}</th><th>{en.assemblies.basis}</th><th>{en.assemblies.product}</th><th>Coverage</th><th>{en.assemblies.enabled}</th><th /></tr></thead>
            <tbody>
              {materialRoles.map((m) => {
                const key = `${tier}:${m.role}`, r = rows[key];
                return (
                  <tr key={key}>
                    <td>{(en.assemblies.roles as Record<string, string>)[m.role]}</td>
                    <td className="muted small-text">{m.basis}</td>
                    <td>
                      <select aria-label={en.assemblies.product} value={r.productId} onChange={(e) => set(key, { productId: e.target.value })}>
                        <option value="">{en.assemblies.noProduct}</option>
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                      </select>
                    </td>
                    <td><input aria-label={en.assemblies.coverage(m.per, m.defaultCoverage)} placeholder={String(m.defaultCoverage)} title={en.assemblies.coverage(m.per, m.defaultCoverage)} inputMode="decimal" size={6} value={r.coverage} onChange={(e) => set(key, { coverage: e.target.value })} /></td>
                    <td><input type="checkbox" aria-label={en.assemblies.enabled} checked={r.enabled} onChange={(e) => set(key, { enabled: e.target.checked })} /></td>
                    <td>
                      <button type="button" className="secondary small" disabled={busy === key} onClick={() => save(tier, m.role, "material")}>{en.assemblies.save}</button>
                      {msg[key]?.text && <span className={msg[key].ok ? "ok small-text" : "error small-text"}> {msg[key].text}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h3 className="small-heading">{en.assemblies.labor}</h3>
          <table className="lines">
            <thead><tr><th>{en.assemblies.role}</th><th>{en.assemblies.basis}</th><th>{en.assemblies.description}</th><th>{en.assemblies.unit}</th><th>{en.assemblies.rate}</th><th>{en.assemblies.enabled}</th><th /></tr></thead>
            <tbody>
              {laborRoles.map((l) => {
                const key = `${tier}:${l.role}`, r = rows[key];
                return (
                  <tr key={key}>
                    <td>{(en.assemblies.roles as Record<string, string>)[l.role]}</td>
                    <td className="muted small-text">{l.basis}</td>
                    <td><input aria-label={en.assemblies.description} placeholder={l.label} maxLength={200} value={r.description} onChange={(e) => set(key, { description: e.target.value })} /></td>
                    <td><input aria-label={en.assemblies.unit} placeholder={l.unit} maxLength={8} size={4} value={r.unit} onChange={(e) => set(key, { unit: e.target.value })} /></td>
                    <td><input aria-label={en.assemblies.rate} inputMode="decimal" size={7} value={r.rate} onChange={(e) => set(key, { rate: e.target.value })} /></td>
                    <td><input type="checkbox" aria-label={en.assemblies.enabled} checked={r.enabled} onChange={(e) => set(key, { enabled: e.target.checked })} /></td>
                    <td>
                      <button type="button" className="secondary small" disabled={busy === key} onClick={() => save(tier, l.role, "labor")}>{en.assemblies.save}</button>
                      {msg[key]?.text && <span className={msg[key].ok ? "ok small-text" : "error small-text"}> {msg[key].text}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
