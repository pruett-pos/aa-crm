"use client";

import { useState } from "react";
import { en } from "@/i18n/en.ts";

const ROLES = ["admin", "csr", "estimator", "production_manager", "crew_leader", "accounting"] as const;
const MARKETS = ["west_plains", "springfield", "nw_arkansas"] as const;
const DIVISIONS = ["roofing", "siding", "gutters", "windows_doors", "insulation", "spray_foam", "commercial"] as const;
const roleLabel = (r: string) => (en.roles as Record<string, string>)[r] ?? r;
const pretty = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

type U = { id: string; fullName: string; email: string; phone: string | null; role: string; market: string | null; active: boolean; divisions: string[] };
type Form = { fullName: string; email: string; phone: string; role: string; market: string; divisions: string[] };
const empty: Form = { fullName: "", email: "", phone: "", role: "estimator", market: "", divisions: [] };
const formOf = (u: U): Form => ({ fullName: u.fullName, email: u.email, phone: u.phone ?? "", role: u.role, market: u.market ?? "", divisions: u.divisions });
const errText = (code?: string) => en.users.errors[code ?? ""] ?? en.users.errors.generic;

export function UsersClient({ initial, meId }: { initial: U[]; meId: string }) {
  const [users, setUsers] = useState<U[]>(initial);
  const [form, setForm] = useState<Form>(empty);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Form>(empty);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(url: string, method: "POST" | "PATCH", body: unknown): Promise<{ ok: boolean; user?: U }> {
    setBusy(true);
    setMsg(null);
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as { user?: U; error?: string };
    setBusy(false);
    if (!res?.ok) setMsg({ ok: false, text: errText(res?.status === 429 ? "rate_limited" : out.error) });
    return { ok: !!res?.ok, user: out.user };
  }
  const put = (u: U) => setUsers((xs) => xs.map((x) => (x.id === u.id ? u : x)));

  const fields = (f: Form, set: (f: Form) => void, p: string, isSelf = false) => (
    <>
      <div><label htmlFor={`${p}name`}>{en.users.fullName}</label><input id={`${p}name`} value={f.fullName} maxLength={100} onChange={(e) => set({ ...f, fullName: e.target.value })} /></div>
      <div><label htmlFor={`${p}email`}>{en.users.email}</label><input id={`${p}email`} type="email" value={f.email} maxLength={254} disabled={isSelf} onChange={(e) => set({ ...f, email: e.target.value })} /></div>
      <div><label htmlFor={`${p}phone`}>{en.users.phone}</label><input id={`${p}phone`} inputMode="tel" value={f.phone} maxLength={20} onChange={(e) => set({ ...f, phone: e.target.value })} /></div>
      <div>
        <label htmlFor={`${p}role`}>{en.users.role}</label>
        <select id={`${p}role`} value={f.role} disabled={isSelf} onChange={(e) => set({ ...f, role: e.target.value, divisions: e.target.value === "production_manager" ? f.divisions : [] })}>
          {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor={`${p}market`}>{en.users.market}</label>
        <select id={`${p}market`} value={f.market} onChange={(e) => set({ ...f, market: e.target.value })}>
          <option value="">{en.users.noMarket}</option>
          {MARKETS.map((m) => <option key={m} value={m}>{pretty(m)}</option>)}
        </select>
      </div>
      {f.role === "production_manager" && (
        <fieldset>
          <legend>{en.users.divisions}</legend>
          <p className="muted">{en.users.divisionsHelp}</p>
          {DIVISIONS.map((d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={f.divisions.includes(d)} onChange={(e) => set({ ...f, divisions: e.target.checked ? [...f.divisions, d] : f.divisions.filter((x) => x !== d) })} /> {pretty(d)}
            </label>
          ))}
        </fieldset>
      )}
    </>
  );
  const payload = (f: Form) => ({ fullName: f.fullName, email: f.email, phone: f.phone, role: f.role, market: f.market || null, divisions: f.role === "production_manager" ? f.divisions : [] });

  return (
    <div>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      <section className="report">
        <h2>{en.users.add}</h2>
        {fields(form, setForm, "new")}
        <p>
          <button type="button" disabled={busy} onClick={async () => {
            const r = await call("/api/settings/users", "POST", { ...payload(form), active: true });
            if (r.ok && r.user) {
              setUsers((xs) => [...xs, r.user!]);
              setForm(empty);
              setMsg({ ok: true, text: en.users.added(r.user.fullName) });
            }
          }}>{busy ? en.users.saving : en.users.add}</button>
        </p>
      </section>

      <section className="report">
        {users.length === 0 && <p className="muted">{en.users.empty}</p>}
        <table className="lines">
          <thead><tr><th>{en.users.fullName}</th><th>{en.users.role}</th><th>{en.users.market}</th><th>{en.users.status}</th><th>{en.users.actions}</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                {editId === u.id ? (
                  <td colSpan={5}>
                    {fields(edit, setEdit, `e${u.id}`, u.id === meId)}
                    <p>
                      <button type="button" disabled={busy} onClick={async () => {
                        const r = await call(`/api/settings/users/${u.id}`, "PATCH", payload(edit));
                        if (r.ok && r.user) { put(r.user); setEditId(null); setMsg({ ok: true, text: en.users.saved }); }
                      }}>{busy ? en.users.saving : en.users.save}</button>{" "}
                      <button type="button" onClick={() => setEditId(null)}>{en.users.cancel}</button>
                    </p>
                  </td>
                ) : (
                  <>
                    <td>
                      {u.fullName} {u.id === meId && <span className="muted">{en.users.you}</span>}
                      <br /><span className="muted">{u.email}{u.phone ? ` · ${u.phone}` : ""}</span>
                    </td>
                    <td>{roleLabel(u.role)}{u.divisions.length > 0 && <><br /><span className="muted">{u.divisions.map(pretty).join(", ")}</span></>}</td>
                    <td>{u.market ? pretty(u.market) : "-"}</td>
                    <td>{u.active ? en.users.active : en.users.inactive}</td>
                    <td>
                      <button type="button" disabled={busy} onClick={() => { setEdit(formOf(u)); setEditId(u.id); setMsg(null); }}>{en.users.edit}</button>{" "}
                      {u.id !== meId && (
                        <button type="button" disabled={busy} onClick={async () => {
                          if (u.active && !window.confirm(en.users.confirmDeactivate(u.fullName))) return;
                          const r = await call(`/api/settings/users/${u.id}`, "PATCH", { active: !u.active });
                          if (r.ok && r.user) { put(r.user); setMsg({ ok: true, text: en.users.saved }); }
                        }}>{u.active ? en.users.deactivate : en.users.reactivate}</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
