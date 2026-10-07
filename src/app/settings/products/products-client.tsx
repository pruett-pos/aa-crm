"use client";

import { useState } from "react";
import { en } from "@/i18n/en.ts";

type P = { id: string; sku: string; name: string; unit: string; retailCents: number; specialOrder: boolean; builderCents: number };
type Form = { sku: string; name: string; unit: string; price: string; specialOrder: boolean };
const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const errText = (code?: string) => (en.catalog.errors as Record<string, string>)[code ?? ""] ?? en.catalog.errors.generic;
const empty: Form = { sku: "", name: "", unit: "", price: "", specialOrder: false };
const formOf = (p: P): Form => ({ sku: p.sku, name: p.name, unit: p.unit, price: (p.retailCents / 100).toFixed(2), specialOrder: p.specialOrder });

export function ProductsClient({ initial }: { initial: P[] }) {
  const [items, setItems] = useState<P[]>(initial);
  const [form, setForm] = useState<Form>(empty);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Form>(empty);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(url: string, method: string, body?: Form): Promise<{ ok: boolean; out: { product?: P; error?: string; message?: string } }> {
    setBusy(true);
    setMsg(null);
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify({ ...body, price: body.price }) : undefined }).catch(() => null);
    const out = ((await res?.json().catch(() => ({}))) ?? {}) as { product?: P; error?: string; message?: string };
    setBusy(false);
    if (!res?.ok) setMsg({ ok: false, text: out.message && out.error === "invalid_product" ? out.message : errText(res?.status === 429 ? "rate_limited" : out.error) });
    return { ok: !!res?.ok, out };
  }
  const sorted = (xs: P[]) => [...xs].sort((a, b) => a.name.localeCompare(b.name));

  const fields = (f: Form, set: (f: Form) => void, idp: string) => (
    <>
      <div><label htmlFor={`${idp}sku`}>{en.catalog.sku}</label><input id={`${idp}sku`} value={f.sku} maxLength={40} onChange={(e) => set({ ...f, sku: e.target.value })} /></div>
      <div><label htmlFor={`${idp}name`}>{en.catalog.name}</label><input id={`${idp}name`} value={f.name} maxLength={120} onChange={(e) => set({ ...f, name: e.target.value })} /></div>
      <div><label htmlFor={`${idp}unit`}>{en.catalog.unit}</label><input id={`${idp}unit`} value={f.unit} maxLength={8} size={8} placeholder={en.catalog.unitHint} onChange={(e) => set({ ...f, unit: e.target.value })} /></div>
      <div><label htmlFor={`${idp}price`}>{en.catalog.price}</label><input id={`${idp}price`} inputMode="decimal" value={f.price} maxLength={12} size={10} onChange={(e) => set({ ...f, price: e.target.value })} /></div>
      <label className="check"><input type="checkbox" checked={f.specialOrder} onChange={(e) => set({ ...f, specialOrder: e.target.checked })} /> {en.catalog.specialOrder}</label>
    </>
  );

  return (
    <div>
      {msg && <p className={msg.ok ? "ok" : "error"} role="status">{msg.text}</p>}
      <section className="report">
        <h2>{en.catalog.add}</h2>
        {fields(form, setForm, "new")}
        <p>
          <button type="button" disabled={busy} onClick={async () => {
            const r = await call("/api/settings/products", "POST", form);
            if (r.ok && r.out.product) { setItems((xs) => sorted([...xs, r.out.product!])); setForm(empty); setMsg({ ok: true, text: en.catalog.added }); }
          }}>{en.catalog.add}</button>
        </p>
      </section>

      <section className="report">
        {items.length === 0 && <p className="muted">{en.catalog.none}</p>}
        {items.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="lines">
              <thead><tr><th>{en.catalog.name}</th><th>{en.catalog.sku}</th><th>{en.catalog.unit}</th><th>{en.catalog.price}</th><th>{en.catalog.builder}</th><th>{en.catalog.specialOrder}</th><th /></tr></thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    {editId === p.id ? (
                      <td colSpan={7}>
                        {fields(edit, setEdit, `e${p.id}`)}
                        <p>
                          <button type="button" disabled={busy} onClick={async () => {
                            const r = await call(`/api/settings/products/${p.id}`, "PUT", edit);
                            if (r.ok && r.out.product) { setItems((xs) => sorted(xs.map((x) => (x.id === p.id ? r.out.product! : x)))); setEditId(null); setMsg({ ok: true, text: en.catalog.saved }); }
                          }}>{en.catalog.save}</button>{" "}
                          <button type="button" className="secondary" disabled={busy} onClick={() => setEditId(null)}>{en.catalog.cancel}</button>
                        </p>
                      </td>
                    ) : (
                      <>
                        <td>{p.name}</td>
                        <td className="muted small-text">{p.sku}</td>
                        <td>{p.unit}</td>
                        <td>{money(p.retailCents)}</td>
                        <td>{money(p.builderCents)}</td>
                        <td>{p.specialOrder ? en.catalog.yes : ""}</td>
                        <td>
                          <button type="button" className="secondary small" disabled={busy} onClick={() => { setEditId(p.id); setEdit(formOf(p)); setMsg(null); }}>{en.catalog.edit}</button>{" "}
                          <button type="button" className="secondary small" disabled={busy} onClick={async () => {
                            if (!window.confirm(en.catalog.removeConfirm(p.name))) return;
                            const r = await call(`/api/settings/products/${p.id}`, "DELETE");
                            if (r.ok) { setItems((xs) => xs.filter((x) => x.id !== p.id)); setMsg({ ok: true, text: en.catalog.removed }); }
                          }}>{en.catalog.remove}</button>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
