// Thin Google client for the aerial roof estimate: Geocoding API (address to a point), Solar API
// (buildingInsights:findClosest, the roof's area and pitch) and Maps Static API (one satellite picture).
// Everything Google-specific lives in this folder. Never import this from UI code; go through src/lib/aerial.
//
// The API key travels in the query string (that is how these three APIs take it), so a URL is NEVER logged, stored
// or put in an error message. Logs hold the endpoint name and the HTTP status only: no key, no address, no coordinates.
//
// Written from the published API shapes; Google's documentation site was not reachable when this was built, so the
// parser is defensive and these are NOT yet confirmed against a live call: whether BASE quality needs an extra
// request parameter, and the exact error body for "no building here" (handled: HTTP 404 or status NOT_FOUND).

import { withTimeout } from "../../lib/http/timeout.ts";

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const SOLAR_URL = "https://solar.googleapis.com/v1/buildingInsights:findClosest";
const STATIC_MAP_URL = "https://maps.googleapis.com/maps/api/staticmap";

export const STATIC_MAP_ZOOM = 20;
export const STATIC_MAP_SIZE = "640x640";
const MAX_IMAGE_BYTES = 3_000_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type IntegrationLog = (e: { status: "ok" | "error"; payload?: unknown; error?: string }) => Promise<void>;

export type GoogleErrorKind = "auth" | "rate_limited" | "not_found" | "bad_request" | "server" | "network";

export class GoogleSolarError extends Error {
  kind: GoogleErrorKind;
  constructor(kind: GoogleErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Worth another try: the request may succeed if sent again. Not found, a rejected key and a bad request are final. */
export const isTransient = (kind: GoogleErrorKind) => kind === "network" || kind === "server" || kind === "rate_limited";

export type GeocodeResult = {
  lat: number;
  lng: number;
  /** ROOFTOP means Google placed the point on the building itself; anything else is an approximation. */
  locationType: string;
  partialMatch: boolean;
};

export const QUALITIES = ["HIGH", "MEDIUM", "BASE"] as const;
export type ImageryQuality = (typeof QUALITIES)[number];

export type SolarSegment = { areaM2: number; pitchDegrees: number; azimuthDegrees: number | null };
export type SolarBuilding = {
  center: { lat: number; lng: number } | null;
  imageryQuality: string;
  /** YYYY-MM-DD, or null when Google sent no usable date. */
  imageryDate: string | null;
  /** Sloped area of the whole roof in square meters, or null when Google left it out. */
  wholeRoofAreaM2: number | null;
  segments: SolarSegment[];
  /** The response exactly as Google sent it. */
  raw: unknown;
};

export type GoogleSolarConfig = {
  apiKey: string;
  timeoutMs?: number;
  fetch?: FetchLike;
  log?: IntegrationLog;
};

/** Configuration from the environment, or null when no key is set (the feature then stays off). */
export function googleSolarConfigFromEnv(env: Record<string, string | undefined> = process.env): Pick<GoogleSolarConfig, "apiKey"> | null {
  const apiKey = env.GOOGLE_MAPS_API_KEY?.trim();
  return apiKey ? { apiKey } : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function kindForHttp(status: number): GoogleErrorKind {
  return status === 401 || status === 403 ? "auth" : status === 404 ? "not_found" : status === 429 ? "rate_limited" : status >= 500 ? "server" : "bad_request";
}

function isoDate(d: any): string | null {
  const y = num(d?.year), m = num(d?.month), day = num(d?.day);
  if (!y || !m || y < 1990 || y > 2200 || m < 1 || m > 12) return null;
  const dd = day && day >= 1 && day <= 31 ? day : 1;
  return `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Read a buildingInsights response into the few fields the CRM uses. Exported for tests. */
export function parseBuilding(body: any): SolarBuilding {
  const sp = body?.solarPotential ?? {};
  const segments: SolarSegment[] = (Array.isArray(sp.roofSegmentStats) ? sp.roofSegmentStats : []).flatMap((s: any) => {
    const areaM2 = num(s?.stats?.areaMeters2);
    const pitchDegrees = num(s?.pitchDegrees);
    if (areaM2 === null || areaM2 <= 0 || pitchDegrees === null) return [];
    return [{ areaM2, pitchDegrees, azimuthDegrees: num(s?.azimuthDegrees) }];
  });
  const lat = num(body?.center?.latitude), lng = num(body?.center?.longitude);
  return {
    center: lat !== null && lng !== null ? { lat, lng } : null,
    imageryQuality: typeof body?.imageryQuality === "string" ? body.imageryQuality.toUpperCase() : "",
    imageryDate: isoDate(body?.imageryDate),
    wholeRoofAreaM2: num(sp?.wholeRoofStats?.areaMeters2),
    segments,
    raw: body,
  };
}

export function createGoogleSolarClient(cfg: GoogleSolarConfig) {
  const doFetch: FetchLike = cfg.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = cfg.timeoutMs ?? 8000;
  // Logging is best effort: a logging problem must never change the outcome of a call.
  const log: IntegrationLog = async (e) => { try { await cfg.log?.(e); } catch { /* ignore */ } };

  async function get(endpoint: string, url: string, params: Record<string, string>): Promise<Response> {
    const qs = new URLSearchParams({ ...params, key: cfg.apiKey }).toString();
    let res: Response;
    try {
      res = await withTimeout(timeoutMs, (signal) => doFetch(`${url}?${qs}`, { method: "GET", signal }));
    } catch {
      await log({ status: "error", payload: { endpoint }, error: "network" });
      throw new GoogleSolarError("network", "Could not reach Google");
    }
    if (!res.ok) {
      const kind = kindForHttp(res.status);
      await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: kind });
      throw new GoogleSolarError(kind, `Google returned HTTP ${res.status}`);
    }
    return res;
  }

  async function json(endpoint: string, res: Response): Promise<any> {
    try {
      const body = await res.json();
      if (body && typeof body === "object") return body;
    } catch { /* fall through */ }
    await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: "server" });
    throw new GoogleSolarError("server", "Unexpected response from Google");
  }

  /** One Solar API request at exactly this minimum quality. */
  async function buildingAt(lat: number, lng: number, quality: ImageryQuality): Promise<SolarBuilding> {
    const endpoint = `solar.findClosest ${quality}`;
    const res = await get(endpoint, SOLAR_URL, {
      "location.latitude": lat.toFixed(6), "location.longitude": lng.toFixed(6), requiredQuality: quality,
    });
    const body = await json(endpoint, res);
    await log({ status: "ok", payload: { endpoint, httpStatus: res.status } });
    return parseBuilding(body);
  }

  return {
    /** The address as a point on the map. Throws not_found when Google has no match. */
    async geocode(address: string): Promise<GeocodeResult> {
      const endpoint = "geocode";
      const res = await get(endpoint, GEOCODE_URL, { address });
      const body = await json(endpoint, res);
      // The Geocoding API answers HTTP 200 with its own status word.
      const status = typeof body.status === "string" ? body.status : "";
      if (status !== "OK") {
        const kind: GoogleErrorKind =
          status === "ZERO_RESULTS" ? "not_found"
          : status === "OVER_QUERY_LIMIT" || status === "OVER_DAILY_LIMIT" ? "rate_limited"
          : status === "REQUEST_DENIED" ? "auth"
          : status === "INVALID_REQUEST" ? "bad_request" : "server";
        await log({ status: "error", payload: { endpoint, httpStatus: res.status, googleStatus: status.slice(0, 40) }, error: kind });
        throw new GoogleSolarError(kind, `Geocoding answered ${status.slice(0, 40) || "nothing"}`);
      }
      const first = Array.isArray(body.results) ? body.results[0] : null;
      const lat = num(first?.geometry?.location?.lat), lng = num(first?.geometry?.location?.lng);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: "not_found" });
        throw new GoogleSolarError("not_found", "Geocoding returned no location");
      }
      await log({ status: "ok", payload: { endpoint, httpStatus: res.status } });
      return {
        lat, lng,
        locationType: typeof first.geometry.location_type === "string" ? first.geometry.location_type : "",
        partialMatch: first.partial_match === true,
      };
    },

    buildingAt,

    /**
     * The closest building at the best imagery Google has: HIGH first, then MEDIUM, then BASE. Stepping down a quality
     * level is not a retry (each level is asked once). Throws not_found when no level has the building.
     */
    async findBuilding(lat: number, lng: number): Promise<SolarBuilding> {
      for (const q of QUALITIES) {
        try {
          return await buildingAt(lat, lng, q);
        } catch (e) {
          if (!(e instanceof GoogleSolarError) || e.kind !== "not_found") throw e;
        }
      }
      throw new GoogleSolarError("not_found", "Google has no roof data for this location");
    },

    /** One satellite picture centered on the point (zoom 20, 640x640). */
    async satelliteImage(lat: number, lng: number): Promise<{ data: Uint8Array; mime: string }> {
      const endpoint = "staticmap";
      const res = await get(endpoint, STATIC_MAP_URL, {
        center: `${lat.toFixed(6)},${lng.toFixed(6)}`, zoom: String(STATIC_MAP_ZOOM), size: STATIC_MAP_SIZE, maptype: "satellite",
      });
      const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      let data: Uint8Array;
      try {
        data = new Uint8Array(await res.arrayBuffer());
      } catch {
        await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: "network" });
        throw new GoogleSolarError("network", "Could not download the satellite image");
      }
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime) || data.length === 0 || data.length > MAX_IMAGE_BYTES) {
        await log({ status: "error", payload: { endpoint, httpStatus: res.status }, error: "server" });
        throw new GoogleSolarError("server", "Unexpected satellite image from Google");
      }
      await log({ status: "ok", payload: { endpoint, httpStatus: res.status } });
      return { data, mime };
    },
  };
}

export type GoogleSolarClient = ReturnType<typeof createGoogleSolarClient>;
