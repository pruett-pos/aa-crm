"use client";

import { useState } from "react";
import { en } from "@/i18n/en.ts";
import { LEAD_SOURCES } from "@/lib/leads/types.ts";

type Cell = { source: string; month: string; dollars: string };
const errText = (code?: string) => (en.leads.errors as Record<string, string>)[code ?? ""] ?? en.leads.errors.generic;

export function SpendGrid({ months, initial }: { months: string[]; initial: Cell[] }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(initial.map((c) => [`${c.source}|${c.month}`, c.dollars])));
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  async function save(source: string, month: string) {
    const key = `${source}|${month}`;
    const amount = (values[key] ?? "").trim();
    if (amount === "") return; // nothing typed: leave any saved value alone
    setError(null);
    const res = await fetch("/api/settings/marketing-spend", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, month, amount }),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return setError(errText(out.error));
    setSaved((s) => ({ ...s, [key]: true }));
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}
      <table className="lines">
        <thead><tr><th>{en.leads.spendCol}</th>{months.map((m) => <th key={m}>{m}</th>)}</tr></thead>
        <tbody>
          {LEAD_SOURCES.map((s) => (
            <tr key={s}>
              <td>{en.leads.sources[s]}</td>
              {months.map((m) => {
                const key = `${s}|${m}`;
                return (
                  <td key={m}>
                    <input aria-label={`${en.leads.sources[s]} ${m}`} inputMode="decimal" placeholder="$"
                      value={values[key] ?? ""}
                      onChange={(e) => { setValues((v) => ({ ...v, [key]: e.target.value })); setSaved((x) => ({ ...x, [key]: false })); }}
                      onBlur={() => save(s, m)} />
                    {saved[key] && <span className="ok small-text">{en.leads.spendSaved}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
