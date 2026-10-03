// Thin CompanyCam client (API v2). Everything CompanyCam-specific lives in this folder so that moving to
// CompanyCam's newer API later only touches here. Never import this from UI code; go through the API routes.
//
// NOTE: CompanyCam says v2 is retiring in early 2027. Plan a migration before then.

const DEFAULT_BASE = "https://api.companycam.com/v2";

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
  status: string;
  address: { street: string | null; city: string | null; state: string | null; postalCode: string | null };
};
export type CcPhoto = { id: string; thumbnailUrl: string | null; capturedAt: string | null; creatorName: string | null };

export type CompanyCamConfig = {
  token: string;
  userEmail?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  log?: IntegrationLog;
};

/** Configuration from the environment, or null when no token is set (the feature then stays off). */
export function companyCamConfigFromEnv(env: Record<string, string | undefined> = process.env): Omit<CompanyCamConfig, "fetch" | "log"> | null {
  const token = env.COMPANYCAM_ACCESS_TOKEN?.trim();
  if (!token) return null;
  return { token, userEmail: env.COMPANYCAM_USER_EMAIL?.trim() || null, baseUrl: env.COMPANYCAM_API_BASE?.trim() || undefined };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function normalizeProject(j: any): CcProject {
  const id = j?.id === undefined || j?.id === null ? "" : String(j.id);
  if (!id) throw new CompanyCamError("server", "Unexpected response from CompanyCam");
  const a = j.address ?? {};
  return {
    id, name: str(j.name), projectUrl: str(j.project_url), status: typeof j.status === "string" ? j.status : "active",
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

  async function call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<any> {
    const qs = opts.query ? `?${new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString()}` : "";
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (cfg.userEmail && method === "POST") headers["X-CompanyCam-User"] = cfg.userEmail;
    // The log records the endpoint path only: no token, no query (which can hold an address), no body.
    const endpoint = `${method} ${path.replace(/\/[0-9]+(?=\/|$)/g, "/:id")}`;

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
        res.status === 401 || res.status === 403 ? "auth"
        : res.status === 404 ? "not_found"
        : res.status === 429 ? "rate_limited"
        : res.status >= 500 ? "server" : "bad_request";
      await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: kind });
      throw new CompanyCamError(kind, `CompanyCam returned HTTP ${res.status}`, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    await log({ status: "ok", payload: { endpoint, httpStatus: res.status } });
    try {
      return await res.json();
    } catch {
      throw new CompanyCamError("server", "Unexpected response from CompanyCam");
    }
  }

  return {
    async createProject(a: { name: string; address: CcAddress; contactName?: string | null }): Promise<CcProject> {
      const body: Record<string, unknown> = {
        name: a.name,
        address: { street_address_1: a.address.street, city: a.address.city, state: a.address.state, postal_code: a.address.postalCode, country: "US" },
      };
      if (a.contactName) body.primary_contact = { name: a.contactName };
      return normalizeProject(await call("POST", "/projects", { body }));
    },

    /** CompanyCam matches the query against project name or address line 1. Active projects only. */
    async searchProjects(query: string, perPage = 25): Promise<CcProject[]> {
      const j = await call("GET", "/projects", { query: { query, status: "active", per_page: perPage } });
      return (Array.isArray(j) ? j : []).map(normalizeProject);
    },

    async getProject(id: string): Promise<CcProject> {
      return normalizeProject(await call("GET", `/projects/${encodeURIComponent(id)}`));
    },

    async listPhotos(projectId: string, perPage = 100): Promise<CcPhoto[]> {
      const j = await call("GET", `/projects/${encodeURIComponent(projectId)}/photos`, { query: { per_page: perPage } });
      return (Array.isArray(j) ? j : []).map(normalizePhoto);
    },
  };
}

export type CompanyCamClient = ReturnType<typeof createCompanyCamClient>;
