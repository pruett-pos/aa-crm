"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { en } from "@/i18n/en.ts";
import { can, type Role } from "@/lib/auth/roles.ts";
import { computeScope } from "@/lib/scopes/service.ts";
import type { ScopeView } from "@/lib/scopes/service.ts";
import type { CatalogItem } from "@/lib/scopes/load.ts";
import { TIERS, type LineKind, type ScopeItemInput, type Tier } from "@/lib/scopes/types.ts";
import { SCOPE_DEFAULT_TARGET_MARGIN_BPS, commissionRateBps } from "@/lib/rules.ts";

type Line = { kind: LineKind; productId: string; description: string; quantity: string; unitCost: string };
type Draft = { title: string; targetPct: string; lines: Line[] };

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

function draftFrom(view: ScopeView | undefined, tier: Tier): Draft {
  if (!view) return { title: en.scope.tiers[tier], targetPct: String(SCOPE_DEFAULT_TARGET_MARGIN_BPS / 100), lines: [] };
  return {
    title: view.title,
    targetPct: String((view.targetMarginBps ?? SCOPE_DEFAULT_TARGET_MARGIN_BPS) / 100),
    lines: view.items.map((i) => ({
      kind: i.kind, productId: i.productId ?? "", description: i.kind === "material" ? "" : i.description,
      quantity: String(i.quantity), unitCost: i.kind === "material" ? "" : ((i.unitCostCents ?? 0) / 100).toFixed(2),
    })),
  };
}

function toInput(d: Draft): { targetMarginBps: number; items: ScopeItemInput[] } {
  return {
    targetMarginBps: Math.round(parseFloat(d.targetPct) * 100),
    items: d.lines.map((l) => ({
      kind: l.kind,
      ...(l.kind === "material"
        ? { productId: l.productId }
        : { description: l.description, unitCostCents: Math.round(parseFloat(l.unitCost || "0") * 100) }),
      quantity: parseFloat(l.quantity),
    })),
  };
}

export function ScopeBuilder(props: {
  jobId: string; canEdit: boolean; role: Role; products: CatalogItem[];
  initial: ScopeView[]; commissionOwnTruck: boolean | null;
  selectedTier: Tier | null; locked: boolean;
}) {
  const { jobId, canEdit, role, products, commissionOwnTruck, selectedTier, locked } = props;
  const router = useRouter();
  const [selectFailed, setSelectFailed] = useState(false);
  const showMargin = can(role, "seeScopeMargin");
  const [tier, setTier] = useState<Tier>("good");
  const [drafts, setDrafts] = useState<Record<Tier, Draft>>(() => {
    const by = (t: Tier) => props.initial.find((s) => s.tier === t);
    return { good: draftFrom(by("good"), "good"), better: draftFrom(by("better"), "better"), best: draftFrom(by("best"), "best") };
  });
  const [saved, setSaved] = useState<Record<Tier, ScopeView | undefined>>(() => ({
    good: props.initial.find((s) => s.tier === "good"),
    better: props.initial.find((s) => s.tier === "better"),
    best: props.initial.find((s) => s.tier === "best"),
  }));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");

  const draft = drafts[tier];
  const update = (patch: Partial<Draft>) => {
    setStatus("idle");
    setDrafts((d) => ({ ...d, [tier]: { ...d[tier], ...patch } }));
  };
  const setLine = (i: number, patch: Partial<Line>) =>
    update({ lines: draft.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) });
  const addLine = (kind: LineKind) =>
    update({ lines: [...draft.lines, { kind, productId: "", description: "", quantity: "1", unitCost: "" }] });

  // Live preview uses the same pricing code as the server. The server recomputes on save.
  const preview = useMemo(() => {
    if (!canEdit) return null;
    try {
      return computeScope({ tier, title: draft.title || "x", ...toInput(draft) }, products.map((p) => ({ ...p, sku: "" })));
    } catch {
      return null;
    }
  }, [canEdit, draft, tier, products]);

  async function save() {
    setStatus("saving");
    const res = await fetch(`/api/jobs/${jobId}/scopes/${tier}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: draft.title, ...toInput(draft) }),
    });
    if (!res.ok) return setStatus("failed");
    const view = (await res.json()) as ScopeView;
    setSaved((s) => ({ ...s, [tier]: view }));
    setStatus("saved");
    router.refresh(); // saving the selected package voids the selection and any unsigned contract
  }

  async function selectThis() {
    setSelectFailed(false);
    const res = await fetch(`/api/jobs/${jobId}/scopes/${tier}/select`, { method: "POST" });
    if (!res.ok) return setSelectFailed(true);
    router.refresh();
  }

  const shown = preview ?? (saved[tier] && showMargin ? {
    saleCents: saved[tier]!.saleCents, costCents: saved[tier]!.costCents ?? 0, marginBps: saved[tier]!.marginBps ?? 0,
  } : null);
  const rate = shown && commissionOwnTruck !== null ? commissionRateBps(shown.marginBps, commissionOwnTruck) : null;
  const lowMargin = shown && shown.saleCents > 0 && shown.marginBps < 4000;

  return (
    <div>
      <div className="tabs" role="tablist">
        {TIERS.map((t) => (
          <button key={t} role="tab" aria-selected={t === tier} className={t === tier ? "tab on" : "tab"}
            onClick={() => { setTier(t); setStatus("idle"); }}>
            {en.scope.tiers[t]}{t === selectedTier && <span className="tick" title={en.contract.selected}> ✓</span>}
          </button>
        ))}
      </div>

      {!canEdit && <p className="muted">{en.scope.readOnly}</p>}
      {!canEdit && !saved[tier] && <p className="muted">{en.scope.noScopeYet}</p>}

      {canEdit ? (
        <>
          <div className="grid2">
            <div>
              <label htmlFor="title">{en.scope.scopeTitle}</label>
              <input id="title" value={draft.title} onChange={(e) => update({ title: e.target.value })} />
            </div>
            <div>
              <label htmlFor="target">{en.scope.targetMargin}</label>
              <input id="target" inputMode="decimal" value={draft.targetPct} onChange={(e) => update({ targetPct: e.target.value })} />
            </div>
          </div>

          <table className="lines">
            <thead>
              <tr><th>{en.scope.kindLabels.material}</th><th>{en.scope.quantity}</th><th>{en.scope.unitCost}</th><th>{en.scope.unitPrice}</th><th /></tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => {
                const computed = preview?.items[i];
                return (
                  <tr key={i}>
                    <td>
                      {l.kind === "material" ? (
                        <select aria-label={en.scope.product} value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
                          <option value="">{en.scope.pickProduct}</option>
                          {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.unit})</option>)}
                        </select>
                      ) : (
                        <input aria-label={en.scope.description} placeholder={en.scope.kindLabels[l.kind]} value={l.description}
                          onChange={(e) => setLine(i, { description: e.target.value })} />
                      )}
                    </td>
                    <td><input aria-label={en.scope.quantity} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                    <td>
                      {l.kind === "material" ? <span className="muted">{computed ? money(computed.unitCostCents) : "-"}</span> : (
                        <input aria-label={en.scope.unitCost} inputMode="decimal" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} />
                      )}
                    </td>
                    <td>{computed ? money(computed.unitPriceCents) : "-"}</td>
                    <td><button className="secondary small" onClick={() => update({ lines: draft.lines.filter((_, idx) => idx !== i) })}>{en.scope.remove}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row">
            <button className="secondary small" onClick={() => addLine("material")}>{en.scope.addMaterial}</button>
            <button className="secondary small" onClick={() => addLine("labor")}>{en.scope.addLabor}</button>
            <button className="secondary small" onClick={() => addLine("misc")}>{en.scope.addMisc}</button>
          </div>
        </>
      ) : (
        saved[tier] && (
          <table className="lines">
            <thead><tr><th>{en.scope.description}</th><th>{en.scope.quantity}</th><th>{en.scope.unitPrice}</th></tr></thead>
            <tbody>
              {saved[tier]!.items.map((i, idx) => (
                <tr key={idx}><td>{i.description}</td><td>{i.quantity}</td><td>{money(i.unitPriceCents)}</td></tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {shown && (
        <div className="panel">
          <h2>{en.scope.totals}</h2>
          <dl>
            <div><dt>{en.scope.salePrice}</dt><dd>{money(shown.saleCents)}</dd></div>
            {showMargin && <div><dt>{en.scope.cost}</dt><dd>{money(shown.costCents)}</dd></div>}
            {showMargin && <div><dt>{en.scope.margin}</dt><dd className={lowMargin ? "warn" : ""}>{pct(shown.marginBps)}</dd></div>}
            {rate !== null && (
              <div><dt>{role === "admin" ? en.scope.commissionAdmin : en.scope.commission}</dt><dd>{pct(rate)}</dd></div>
            )}
          </dl>
          {lowMargin && showMargin && <p className="warn">{en.scope.belowTarget}</p>}
          {showMargin && <p className="muted small-text">{en.scope.marginNote}</p>}
        </div>
      )}
      {!shown && !canEdit && saved[tier] && (
        <div className="panel"><dl><div><dt>{en.scope.salePrice}</dt><dd>{money(saved[tier]!.saleCents)}</dd></div></dl></div>
      )}

      {canEdit && !locked && (
        <div className="row">
          <button onClick={save} disabled={status === "saving"}>{status === "saving" ? en.scope.saving : en.scope.save}</button>
          {saved[tier] && selectedTier !== tier && (
            <button className="secondary" onClick={selectThis}>{en.contract.selectPackage}</button>
          )}
          {selectedTier === tier && <span className="badge">{en.contract.selected}</span>}
          {status === "saved" && <span className="muted">{en.scope.saved}</span>}
          {status === "failed" && <span className="error">{en.scope.saveFailed}</span>}
          {selectFailed && <span className="error">{en.contract.selectFailed}</span>}
        </div>
      )}
      {canEdit && locked && <p className="muted">{en.contract.locked}</p>}
    </div>
  );
}
