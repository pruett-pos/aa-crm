// Thin CompanyCam client (current public API, /public_api/v1). Everything CompanyCam-specific lives in this folder.
// Never import this from UI code; go through the API routes.
//
// Responses come in an envelope { data, errors, meta }; lists page with a cursor (limit / after).
// Not documented in CompanyCam's published API file, so not assumed: rate limits, Retry-After (honored if sent),
// whether image URLs expire, and how many different project status values exist.

const DEFAULT_BASE = "https://app.companycam.com/public_api/v1";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type IntegrationLog = (e: { status: "ok" | "error"; payload?: unknown; error?: string }) => Promise<void>;

export type CompanyCamErrorKind = "auth" | "rate_limited" | "not_found" | "bad_request" | "server" | "network";

export class CompanyCamError extends Error {
  kind: CompanyCamErrorKind;
  retryAfterSeconds: number | null;
  constructor(kind: CompanyCamErrorKind, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type CcAddress = { street: string; city: string; state: string; postalCode: string };
export type CcProject = {
  id: string;
  name: string | null;
  projectUrl: string | null;
  /** "archived" or "deleted" when CompanyCam says so, otherwise "active". */
  status: string;
  address: { street: string | null; city: string | null; state: string | null; postalCode: string | null };
};
export type CcPhoto = { id: string; thumbnailUrl: string | null; capturedAt: string | null; creatorName: string | null };

export type CompanyCamConfig = {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  log?: IntegrationLog;
};

/** Configuration from the environment, or null when no token is set (the feature then stays off). */
export function companyCamConfigFromEnv(env: Record<string, string | undefined> = process.env): Omit<CompanyCamConfig, "fetch" | "log"> | null {
  const token = env.COMPANYCAM_ACCESS_TOKEN?.trim();
  if (!token) return null;
  return { token, baseUrl: env.COMPANYCAM_API_BASE?.trim() || undefined };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function normalizeProject(j: any): CcProject {
  const id = j?.id === undefined || j?.id === null ? "" : String(j.id);
  if (!id) throw new CompanyCamError("server", "Unexpected response from CompanyCam");
  const a = j.address ?? {};
  const raw = typeof j.status === "string" ? j.status.toLowerCase() : "";
  const status = j.archived === true || raw.includes("archiv") ? "archived" : raw.includes("delet") ? "deleted" : "active";
  return {
    id, name: str(j.name), projectUrl: str(j.project_url), status,
    address: { street: str(a.street_address_1), city: str(a.city), state: str(a.state), postalCode: str(a.postal_code) },
  };
}

function normalizePhoto(p: any): CcPhoto {
  const uris: any[] = Array.isArray(p?.uris) ? p.uris : [];
  const pick = (type: string) => {
    const u = uris.find((x) => x?.type === type);
    return str(u?.uri) ?? str(u?.url);
  };
  return {
    id: String(p?.id ?? ""),
    thumbnailUrl: pick("thumbnail") ?? pick("web"),        // thumbnails only; originals are never listed
    capturedAt: typeof p?.captured_at === "number" ? new Date(p.captured_at * 1000).toISOString() : str(p?.captured_at),
    creatorName: str(p?.creator_name),
  };
}

export function createCompanyCamClient(cfg: CompanyCamConfig) {
  const base = (cfg.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const doFetch: FetchLike = cfg.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = cfg.timeoutMs ?? 8000;

  // Logging is best effort: a logging problem must never change the outcome of a CompanyCam call.
  const log: IntegrationLog = async (e) => { try { await cfg.log?.(e); } catch { /* ignore */ } };

  /** Returns the envelope's `data` and `meta`. */
  async function call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<{ data: any; meta: any }> {
    const qs = opts.query ? `?${new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString()}` : "";
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    // The log records the endpoint path only: no token, no query (which can hold an address), no body, no project id.
    const endpoint = `${method} ${path.replace(/^\/projects\/(?!search(?:\/|$))[^/]+/, "/projects/:id")}`;

    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs}`, {
        method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      await log({ status: "error", payload: { endpoint }, error: "network" });
      throw new CompanyCamError("network", "Could not reach CompanyCam");
    }
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after"));
      const kind: CompanyCamErrorKind =
        res.status === 401 || res.status === 403 ? "auth"   // invalid_token, token_expired, token_revoked, insufficient_scope
        : res.status === 404 ? "not_found"
        : res.status === 429 ? "rate_limited"
        : res.status >= 500 ? "server" : "bad_request";
      await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: kind });
      throw new CompanyCamError(kind, `CompanyCam returned HTTP ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: "server" });
      throw new CompanyCamError("server", "Unexpected response from CompanyCam");
    }
    // A 200 whose envelope carries errors, or has no data, is a failure too.
    if (!body || typeof body !== "object" || body.data === undefined || body.data === null || (Array.isArray(body.errors) && body.errors.length > 0)) {
      await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: "server" });
      throw new CompanyCamError("server", "Unexpected response from CompanyCam");
    }
    await log({ status: "ok", payload: { endpoint, httpStatus: res.status } });
    return { data: body.data, meta: body.meta ?? {} };
  }

  return {
    async createProject(a: { name: string; address: CcAddress; contactName?: string | null }): Promise<CcProject> {
      const project: Record<string, unknown> = {
        name: a.name, street_address_1: a.address.street, city: a.address.city, state: a.address.state,
        postal_code: a.address.postalCode, country: "US",
      };
      if (a.contactName) project.primary_contact = { name: a.contactName };
      return normalizeProject((await call("POST", "/projects", { body: { project } })).data);
    },

    /** Matches the query against project name and address. Includes archived projects; callers filter on `status`. */
    async searchProjects(query: string): Promise<CcProject[]> {
      const { data } = await call("GET", "/projects/search", { query: { query } });
      return (Array.isArray(data) ? data : []).map(normalizeProject);
    },

    async getProject(id: string): Promise<CcProject> {
      return normalizeProject((await call("GET", `/projects/${encodeURIComponent(id)}`)).data);
    },

    /** One page of photos (at most 100), with whether CompanyCam has more. */
    async listPhotos(projectId: string, limit = 100): Promise<{ photos: CcPhoto[]; hasMore: boolean }> {
      const { data, meta } = await call("GET", `/projects/${encodeURIComponent(projectId)}/photos`, { query: { limit: Math.min(100, Math.max(1, limit)) } });
      return { photos: (Array.isArray(data) ? data : []).map(normalizePhoto), hasMore: meta?.has_next === true };
    },
  };
}

export type CompanyCamClient = ReturnType<typeof createCompanyCamClient>;
