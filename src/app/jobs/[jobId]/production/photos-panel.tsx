"use client";

import { useCallback, useEffect, useState } from "react";
import { en } from "@/i18n/en.ts";
import type { PhotosView } from "@/lib/companycam/logic.ts";

type Data = (PhotosView & { canManage?: boolean; canUnlink?: boolean }) | { state: "failed" };
type Found = { id: string; name: string | null; address: string; linkedToJob: boolean };
type Msg = { ok: boolean; text: string } | null;
const errText = (code?: string) => (en.photos.errors as Record<string, string>)[code ?? ""] ?? en.photos.errors.generic;

export function PhotosPanel({ jobId }: { jobId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [broken, setBroken] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const res = await fetch(`/api/jobs/${jobId}/photos`).catch(() => null);
    setData(res?.ok ? ((await res.json()) as Data) : { state: "failed" });
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function act(body: unknown, okText: string) {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/jobs/${jobId}/companycam`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const out = (await res?.json().catch(() => ({}))) as { error?: string } | undefined;
    setBusy(false);
    if (res?.ok) { setMsg({ ok: true, text: okText }); setFound(null); await load(); }
    else setMsg({ ok: false, text: errText(res?.status === 429 ? "rate_limited" : out?.error) });
  }

  async function search() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/jobs/${jobId}/companycam/search?q=${encodeURIComponent(q)}`).catch(() => null);
    const out = (await res?.json().catch(() => ({}))) as { projects?: Found[]; error?: string } | undefined;
    setBusy(false);
    if (res?.ok) setFound(out?.projects ?? []);
    else setMsg({ ok: false, text: errText(res?.status === 429 ? "rate_limited" : out?.error) });
  }

  if (!data) return <section className="report"><h2>{en.photos.title}</h2><p className="muted">{en.photos.loading}</p></section>;
  if (data.state === "failed") return <section className="report"><h2>{en.photos.title}</h2><p className="muted">{en.photos.unavailable}</p></section>;

  const canManage = data.canManage === true;
  const projectUrl = data.state === "ok" || data.state === "error" ? data.projectUrl : null;

  return (
    <section className="report">
      <h2>{en.photos.title}</h2>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}

      {data.state === "not_configured" && <p className="muted">{en.photos.notConfigured}</p>}

      {data.state === "not_linked" && (
        <>
          <p className="muted">
            {data.status === "pending" ? en.photos.pending : data.status === "error" && data.error ? en.photos.failedWithError(data.error) : en.photos.notLinked}
          </p>
          {canManage && (
            <>
              <p className="noprint">
                <button type="button" disabled={busy} onClick={() => act({ action: "create" }, en.photos.requested)}>
                  {data.status === "error" ? en.photos.retry : en.photos.create}
                </button>
              </p>
              <LinkExisting q={q} setQ={setQ} search={search} found={found} busy={busy} link={(id) => act({ action: "link", projectId: id }, en.photos.linked)} />
            </>
          )}
        </>
      )}

      {(data.state === "ok" || data.state === "error") && (
        <>
          <p>
            {projectUrl && <a href={projectUrl} target="_blank" rel="noopener noreferrer">{en.photos.open}</a>}
            {data.state === "ok" && <span className="muted"> · {en.photos.count(data.count, data.hasMore)}</span>}
          </p>
          {data.state === "error" && <p className="muted">{en.photos.unavailable}</p>}
          {data.state === "ok" && data.photos.length === 0 && <p className="muted">{en.photos.none}</p>}
          {data.state === "ok" && data.photos.length > 0 && (
            <>
              <p className="small-text muted">{en.photos.latest}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {data.photos.filter((p) => !broken.has(p.id)).map((p) => (
                  <a key={p.id} href={projectUrl ?? undefined} target="_blank" rel="noopener noreferrer">
                    {/* Thumbnails come from CompanyCam; if one fails to load it is simply hidden. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.thumbnailUrl} alt="" width={96} height={96} loading="lazy" referrerPolicy="no-referrer" style={{ objectFit: "cover", borderRadius: 4 }}
                      onError={() => setBroken((s) => new Set(s).add(p.id))} />
                  </a>
                ))}
              </div>
            </>
          )}
          {data.canUnlink && (
            <p className="noprint">
              <button type="button" disabled={busy} onClick={() => { if (window.confirm(en.photos.unlinkConfirm)) void act({ action: "unlink" }, en.photos.unlinked); }}>
                {en.photos.unlink}
              </button>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function LinkExisting(p: { q: string; setQ: (s: string) => void; search: () => void; found: Found[] | null; busy: boolean; link: (id: string) => void }) {
  return (
    <details className="noprint">
      <summary>{en.photos.linkExisting}</summary>
      <label>
        {en.photos.searchLabel}
        <input value={p.q} maxLength={80} onChange={(e) => p.setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") p.search(); }} />
      </label>{" "}
      <button type="button" disabled={p.busy || p.q.trim().length < 3} onClick={p.search}>{en.photos.searchButton}</button>
      {p.found && p.found.length === 0 && <p className="muted">{en.photos.noResults}</p>}
      {p.found && p.found.map((f) => (
        <p key={f.id}>
          {f.name ?? f.address} <span className="muted">· {f.address}</span>{" "}
          {f.linkedToJob ? <span className="muted">{en.photos.linkedElsewhere}</span> : <button type="button" disabled={p.busy} onClick={() => p.link(f.id)}>{en.photos.link}</button>}
        </p>
      ))}
    </details>
  );
}
