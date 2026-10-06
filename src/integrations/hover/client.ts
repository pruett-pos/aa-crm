// Thin Hover client (API v3, https://hover.to/api/v3). Everything Hover-specific lives in this folder.
// Never import this from UI code; go through the API routes.
//
// Verified from developers.hover.to: GET /api/v3/jobs (search, per, page; each job has a models list), and
// GET /api/v3/models/{model_id}/artifacts/measurements.json?version=full_json. Not documented there, so not assumed:
// rate limits and Retry-After (honored if sent).

const DEFAULT_BASE = "https://hover.to";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type IntegrationLog = (e: { status: "ok" | "error"; payload?: unknown; error?: string }) => Promise<void>;

export type HoverErrorKind = "auth" | "rate_limited" | "not_found" | "bad_request" | "server" | "network";

export class HoverError extends Error {
  kind: HoverErrorKind;
  retryAfterSeconds: number | null;
  constructor(kind: HoverErrorKind, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type HoverJob = {
  id: string;
  name: string | null;
  /** completed, draft or failed */
  state: string;
  externalId: string | null;
  address: { street: string | null; city: string | null; state: string | null; postalCode: string | null };
  models: { id: string; state: string }[];
};

export type HoverConfig = {
  /** A current access token; with `forceRefresh` it must get a new one (used once after a 401). */
  getAccessToken: (forceRefresh: boolean) => Promise<string>;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  log?: IntegrationLog;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const id = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function normalizeJob(j: any): HoverJob {
  const jid = id(j?.id);
  if (!jid) throw new HoverError("server", "Unexpected response from Hover");
  const a = j.address ?? {};
  return {
    id: jid, name: str(j.name), state: str(j.reconstruction_state) ?? "unknown", externalId: str(j.external_identifier),
    address: { street: str(a.location_line_1), city: str(a.city), state: str(a.region), postalCode: str(a.postal_code) },
    models: (Array.isArray(j.models) ? j.models : []).flatMap((m: any) => (id(m?.id) ? [{ id: id(m.id), state: str(m.state) ?? "unknown" }] : [])),
  };
}

export function createHoverClient(cfg: HoverConfig) {
  const base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const doFetch: FetchLike = cfg.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = cfg.timeoutMs ?? 15_000;
  const log: IntegrationLog = async (e) => { try { await cfg.log?.(e); } catch { /* logging never changes the outcome */ } };

  async function get(path: string, query: Record<string, string | number> = {}, retried = false): Promise<any> {
    const qs = Object.keys(query).length ? `?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString()}` : "";
    // The log records the endpoint only: no token, no search text (which can be an address), no ids.
    const endpoint = `GET ${path.replace(/\/models\/[^/]+/, "/models/:id")}`;
    let res: Response;
    try {
      const token = await cfg.getAccessToken(retried);
      res = await doFetch(`${base}${path}${qs}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (e instanceof HoverError) { await log({ status: "error", payload: { endpoint }, error: e.kind }); throw e; }
      await log({ status: "error", payload: { endpoint }, error: "network" });
      throw new HoverError("network", "Could not reach Hover");
    }
    if (res.status === 401 && !retried) return get(path, query, true);       // the token may have just been rotated: try once with a fresh one
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after"));
      const kind: HoverErrorKind = res.status === 401 || res.status === 403 ? "auth" : res.status === 404 ? "not_found" : res.status === 429 ? "rate_limited" : res.status >= 500 ? "server" : "bad_request";
      await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: kind });
      throw new HoverError(kind, `Hover returned HTTP ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    try {
      const body = await res.json();
      await log({ status: "ok", payload: { endpoint, httpStatus: res.status } });
      return body;
    } catch {
      await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: "server" });
      throw new HoverError("server", "Unexpected response from Hover");
    }
  }

  return {
    /** Jobs whose name, address or user match (Hover needs at least 3 characters). One page of up to `per` jobs. */
    async listJobs(search: string, per = 25): Promise<HoverJob[]> {
      const q = search.trim();
      if (q.length < 3) return [];
      const j = await get("/api/v3/jobs", { search: q.slice(0, 100), per: Math.min(100, Math.max(1, per)) });
      return (Array.isArray(j?.results) ? j.results : []).map(normalizeJob);
    },

    /** The full measurements JSON for a model, as Hover sends it. Parsing and checking happen in src/lib/measurements. */
    async getMeasurements(modelId: string): Promise<unknown> {
      return get(`/api/v3/models/${encodeURIComponent(modelId)}/artifacts/measurements.json`, { version: "full_json" });
    },
  };
}

export type HoverClient = ReturnType<typeof createHoverClient>;
