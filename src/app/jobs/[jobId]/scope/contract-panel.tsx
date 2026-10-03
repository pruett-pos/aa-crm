"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";
import type { ContractInfo } from "@/lib/contracts/load.ts";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const tradeName = (d: string) => (en.leads.divisionNames as Record<string, string>)[d] ?? d;

export function ContractPanel({ jobId, canEdit, info }: { jobId: string; canEdit: boolean; info: ContractInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const doc = info.document;
  const chosenCount = info.trades.filter((t) => t.selectedTier !== null).length;
  const missing = info.trades.filter((t) => t.selectedTier === null).map((t) => tradeName(t.division));

  async function prepare() {
    setBusy(true);
    setFailed(null);
    const res = await fetch(`/api/jobs/${jobId}/contract`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return setFailed(body.message ?? en.contract.prepareFailed);
    }
    router.refresh();
  }

  return (
    <div className="panel">
      <h2>{en.contract.panelTitle}</h2>
      {chosenCount === 0 || info.contractCents === null ? (
        <p className="muted">{en.contract.pickFirst}</p>
      ) : (
        <>
          <h3 className="small-heading">{en.contract.tradesHeading}</h3>
          <dl>
            {info.trades.map((t) => (
              <div key={t.division}>
                <dt>{tradeName(t.division)}{t.selectedTier ? `: ${en.scope.tiers[t.selectedTier]}` : ""}</dt>
                <dd>{t.subtotalCents !== null ? money(t.subtotalCents) : <span className="warn">{en.contract.notChosen}</span>}</dd>
              </div>
            ))}
          </dl>
          {info.trades.length > 1 && <p className="muted small-text">{en.contract.chosenCount(chosenCount, info.trades.length)}</p>}
          <dl>
            <div><dt>{en.contract.total}</dt><dd>{money(info.contractCents)}</dd></div>
            <div>
              <dt>{en.contract.deposit}</dt>
              <dd>{info.depositRequiredCents > 0 ? money(info.depositRequiredCents) : en.contract.noDeposit}</dd>
            </div>
            {doc && <div><dt>{en.contract.panelTitle}</dt><dd>{en.contract.status[doc.status]}</dd></div>}
          </dl>

          {doc?.status === "signed" && (
            <>
              <p className="muted">{en.contract.locked}</p>
              <p>
                <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer">{en.contract.downloadSigned}</a>
                {doc.signedAt && <span className="muted"> · {en.contract.signedOn(doc.signedAt.slice(0, 10))}</span>}
              </p>
              {canEdit && <p><Link href={`/jobs/${jobId}/payments`}>{en.payments.recordLink}</Link></p>}
            </>
          )}

          {doc?.status === "draft" && canEdit && (
            <div className="row">
              <Link className="btn-link" href={`/jobs/${jobId}/contract/sign`}>{en.contract.openSigning}</Link>
              <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer">{en.contract.review}</a>
            </div>
          )}

          {canEdit && doc?.status !== "signed" && (
            <>
              {!info.allTradesChosen && <p className="warn small-text">{en.contract.chooseAll(missing.join(", "))}</p>}
              <div className="row">
                <button className="secondary small" onClick={prepare} disabled={busy || !info.allTradesChosen}>
                  {busy ? en.contract.preparing : en.contract.prepare}
                </button>
                {failed && <span className="error">{failed}</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
