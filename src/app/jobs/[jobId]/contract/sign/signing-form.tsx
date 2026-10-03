"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { en } from "@/i18n/en.ts";
import { SignaturePad, type SignaturePadHandle } from "./signature-pad.tsx";

type Phase = "form" | "working" | "done";

export function SigningForm(props: { jobId: string; documentId: string; customerName: string; customerEmail: string }) {
  const pad = useRef<SignaturePadHandle>(null);
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState(props.customerName);
  const [email, setEmail] = useState(props.customerEmail);
  const [hasInk, setHasInk] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(true);

  async function sign() {
    const png = pad.current?.toDataUrl();
    if (!png) return setError(en.contract.errors.signature_invalid);
    setError(null);
    setPhase("working");
    const res = await fetch(`/api/documents/${props.documentId}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consent, signerName: name, signerEmail: email, signaturePng: png }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; emailed?: boolean };
    if (!res.ok) {
      setPhase("form");
      const errs = en.contract.errors as Record<string, string>;
      return setError(errs[body.error ?? ""] ?? en.contract.errors.generic);
    }
    setEmailed(body.emailed !== false);
    setPhase("done");
  }

  if (phase === "done") {
    return (
      <>
        <h1>{en.contract.signedTitle}</h1>
        <p>{en.contract.signedBody}</p>
        <p className={emailed ? "muted" : "error"}>{emailed ? en.contract.emailed : en.contract.emailFailed}</p>
        <p><a href={`/api/documents/${props.documentId}/file`} target="_blank" rel="noreferrer">{en.contract.downloadSigned}</a></p>
        <p><Link href={`/jobs/${props.jobId}/scope`}>{en.contract.backToScope}</Link></p>
      </>
    );
  }

  const ready = consent && name.trim().length >= 2 && email.includes("@") && hasInk && phase === "form";
  return (
    <>
      <p className="muted">{en.contract.signingIntro}</p>
      <iframe className="pdf-frame" title={en.contract.review} src={`/api/documents/${props.documentId}/file`} />

      <div className="consent">
        <strong>{en.contract.consentHeading}</strong>
        <p>{en.contract.consentText}</p>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          {en.contract.consentCheck}
        </label>
      </div>

      <div className="grid2">
        <div>
          <label htmlFor="signer-name">{en.contract.nameLabel}</label>
          <input id="signer-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="signer-email">{en.contract.emailLabel}</label>
          <input id="signer-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>

      <label>{en.contract.signHere}</label>
      <SignaturePad ref={pad} label={en.contract.signHere} onChange={setHasInk} />
      <div className="row">
        <button className="secondary small" onClick={() => pad.current?.clear()}>{en.contract.clear}</button>
        <button onClick={sign} disabled={!ready}>{phase === "working" ? en.contract.signing : en.contract.sign}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}
