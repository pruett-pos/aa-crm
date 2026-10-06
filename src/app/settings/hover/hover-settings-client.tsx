"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { en } from "@/i18n/en.ts";

type State = "not_configured" | "not_connected" | "connected" | "needs_reconnect";
const day = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });

export function HoverSettingsClient({ state, refreshedAt }: { state: State; refreshedAt: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function disconnect() {
    if (!window.confirm(en.hover.disconnectConfirm)) return;
    setBusy(true);
    const res = await fetch("/api/hover/disconnect", { method: "POST" }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setMsg(en.hover.disconnected); router.refresh(); }
  }

  return (
    <div className="panel">
      {state === "not_configured" && <p className="warn">{en.hover.notConfigured}</p>}
      {state === "not_connected" && <p>{en.hover.notConnected}</p>}
      {state === "needs_reconnect" && <p className="warn">{en.hover.needsReconnect}</p>}
      {state === "connected" && <p className="ok">{en.hover.connected(refreshedAt ? day(refreshedAt) : "")}</p>}
      {msg && <p className="ok" role="status">{msg}</p>}
      {(state === "not_connected" || state === "needs_reconnect") && (
        <p><a href="/api/hover/connect">{state === "needs_reconnect" ? en.hover.reconnect : en.hover.connect}</a></p>
      )}
      {(state === "connected" || state === "needs_reconnect") && (
        <p><button type="button" disabled={busy} onClick={disconnect}>{en.hover.disconnect}</button></p>
      )}
    </div>
  );
}
