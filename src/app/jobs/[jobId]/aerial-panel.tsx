import { en } from "@/i18n/en.ts";
import { loadAerialPanel } from "@/lib/aerial/index.ts";
import type { AerialJob } from "@/lib/aerial/types.ts";
import { FetchAgainButton } from "./aerial-fetch-again.tsx";

const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const day = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric" });
const num = (n: number) => n.toLocaleString("en-US");
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const facing = (deg: number | null) => (deg === null ? "" : COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]);

/**
 * The property's aerial roof estimate: picture, numbers and (when roofing is on the job) the ballpark price range.
 * Shown to every signed-in user (decided by AL). The ballpark is the customer price only: no cost or margin.
 */
export async function AerialPanel({ job, isAdmin }: { job: AerialJob; isAdmin: boolean }) {
  const a = en.aerial;
  const view = await loadAerialPanel(job);
  if (view.state === "off") return null;
  const e = view.estimate;
  const canFetchAgain = isAdmin && job.jobType !== "condition_report" && view.state !== "pending";

  return (
    <section className="panel">
      <h2>{a.title}</h2>
      {view.state === "none" && <p className="muted">{a.none}</p>}
      {view.state === "pending" && <p className="muted">{a.pending}</p>}
      {view.state === "no_data" && (
        <p><span className="badge">{a.noData}</span>{isAdmin && e?.error ? <span className="muted small-text"> {e.error}</span> : null}</p>
      )}
      {view.state === "ok" && e && e.roofAreaSqft !== undefined && (
        <>
          {e.hasImage
            ? <img src={`/api/properties/${view.propertyId}/aerial-image`} alt={a.imageAlt} width={640} height={640} className="aerial-image" />
            : <p className="muted small-text">{a.noImage}</p>}
          <dl>
            <div><dt>{a.roofArea}</dt><dd>{num(e.roofAreaSqft)} {a.sqft}</dd></div>
            <div><dt>{a.squares}</dt><dd>{((e.squaresX10 ?? 0) / 10).toFixed(1)}</dd></div>
            <div><dt>{a.mainPitch}</dt><dd>{e.mainPitch ?? ""}</dd></div>
            <div><dt>{a.segments}</dt><dd>{e.segmentCount ?? 0}</dd></div>
            <div><dt>{a.confidence}</dt><dd>{a.confidences[e.confidence ?? "low"]}</dd></div>
            <div>
              <dt>{a.imagery}</dt>
              <dd>
                {(a.imageryQuality as Record<string, string>)[e.imageryQuality ?? ""] ?? e.imageryQuality}
                {e.imageryDate ? `, ${day(new Date(`${e.imageryDate}T12:00:00Z`))}` : ""}
              </dd>
            </div>
          </dl>
          <p className="muted small-text">
            {e.fetchedAt ? a.fetched(day(e.fetchedAt)) : ""}
            {e.correctionBps !== undefined && e.correctionBps !== 10_000 && e.rawAreaSqft !== undefined
              ? ` ${a.corrected(String(e.correctionBps / 100), num(e.rawAreaSqft))}` : ""}
          </p>
          {job.divisions.includes("roofing") && (
            <>
              <h2>{a.ballparkTitle}</h2>
              {view.ballpark ? (
                <>
                  <p><strong>{a.ballparkRange(money(view.ballpark.lowCents), money(view.ballpark.highCents))}</strong></p>
                  <dl>
                    {view.ballpark.tiers.map((t) => <div key={t.tier}><dt>{a.tiers[t.tier]}</dt><dd>{money(t.saleCents)}</dd></div>)}
                  </dl>
                  <p className="muted small-text">{a.ballparkHelp(view.ballpark.wastePct)}</p>
                </>
              ) : <p className="muted small-text">{a.ballparkNone}</p>}
            </>
          )}
          {(e.segments?.length ?? 0) > 0 && (
            <details>
              <summary>{a.segmentTable}</summary>
              <table className="lines">
                <thead><tr><th>{a.colSegment}</th><th className="num">{a.colArea}</th><th>{a.colPitch}</th><th>{a.colFacing}</th></tr></thead>
                <tbody>
                  {e.segments!.map((s, i) => (
                    <tr key={i}><td>{i + 1}</td><td className="num">{num(s.areaSqft)}</td><td>{s.pitch}</td><td>{facing(s.azimuthDegrees)}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}
      {canFetchAgain && <FetchAgainButton jobId={job.id} />}
    </section>
  );
}
