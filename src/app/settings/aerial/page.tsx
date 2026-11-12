import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/index.ts";
import { getAerialStore, getGoogleSolarClient } from "@/lib/aerial/index.ts";
import { calibration } from "@/lib/aerial/logic.ts";
import { en } from "@/i18n/en.ts";
import { AerialSettingsForm } from "./settings-form.tsx";

const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
const sq = (x10: number) => (x10 / 10).toFixed(1);
const ft = (ft10: number) => (ft10 / 10).toFixed(1);

// Admin only: the on/off switch, the correction factor, and the aerial vs Hover calibration report.
export default async function AerialSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  const store = getAerialStore();
  const [settings, sources] = await Promise.all([store.getSettings(), store.calibrationSources()]);
  const c = calibration(sources);
  const s = en.aerial.settings, k = en.aerial.calibration;

  return (
    <>
      <p><Link href="/">{en.home.back}</Link></p>
      <h1>{s.title}</h1>
      <p className="muted">{s.help}</p>
      {getGoogleSolarClient() === null && <p className="warn">{s.keyMissing}</p>}
      <AerialSettingsForm initial={settings} />

      <section className="report">
        <h2>{k.title}</h2>
        <p className="muted small-text">{k.help}</p>
        {c.rows.length === 0 ? <p className="muted">{k.none}</p> : (
          <>
            <table className="lines report-table">
              <thead>
                <tr><th>{k.colJob}</th><th className="num">{k.colAerial}</th><th className="num">{k.colHover}</th><th className="num">{k.colDiff}</th></tr>
              </thead>
              <tbody>
                {c.rows.map((r) => (
                  <tr key={r.jobId}>
                    <td><Link href={`/jobs/${r.jobId}`}>{r.jobNumber}</Link> <span className="muted small-text">{r.street}</span></td>
                    <td className="num">{sq(r.aerialSquaresX10)}</td><td className="num">{sq(r.hoverSquaresX10)}</td><td className="num">{pct(r.diffBps)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td colSpan={3}>{k.average(c.rows.length)}: {k.avgError}</td><td className="num">{((c.avgAbsDiffBps ?? 0) / 100).toFixed(1)}%</td></tr>
                <tr><td colSpan={3}>{k.avgBias}</td><td className="num">{pct(c.avgDiffBps ?? 0)}</td></tr>
              </tfoot>
            </table>
            {c.suggestedCorrectionBps !== null && <p>{k.suggested((c.suggestedCorrectionBps / 100).toFixed(1))}</p>}
            {c.hoverFt10PerSq && (
              <p className="muted small-text">
                {k.hoverLengths(ft(c.hoverFt10PerSq.eaves), ft(c.hoverFt10PerSq.rakes), ft(c.hoverFt10PerSq.ridgesHips), ft(c.hoverFt10PerSq.valleys))}
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
