"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";
import type { ContractInfo } from "@/lib/contracts/load.ts";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function ContractPanel({ jobId, canEdit, info }: { jobId: string; canEdit: boolean; info: ContractInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const doc = info.document;

  async function prepare() {
    setBusy(true);
    setFailed(false);
    const res = await fetch(`/api/jobs/${jobId}/contract`, { method: "POST" });
    setBusy(false);
    if (!res.ok) return setFailed(true);
    router.refresh();
  }

  return (
    <div className="panel">
      <h2>{en.contract.panelTitle}</h2>
      {!info.selectedTier || info.contractCents === null ? (
        <p className="muted">{en.contract.pickFirst}</p>
      ) : (
        <>
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
            </>
          )}

          {doc?.status === "draft" && canEdit && (
            <div className="row">
              <Link className="btn-link" href={`/jobs/${jobId}/contract/sign`}>{en.contract.openSigning}</Link>
              <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer">{en.contract.review}</a>
            </div>
          )}

          {canEdit && doc?.status !== "signed" && (
            <div className="row">
              <button className="secondary small" onClick={prepare} disabled={busy}>
                {busy ? en.contract.preparing : en.contract.prepare}
              </button>
              {failed && <span className="error">{en.contract.prepareFailed}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
