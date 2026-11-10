// Thin client for the Pruett POS price feed. Everything Pruett-specific lives in this folder; never import it from UI code.
//
//   GET {PRUETT_FEED_URL}/api/feed/prices?level=Builder     Authorization: Bearer {PRUETT_FEED_KEY}
//   -> { level, level_not_set, generated_at, count, items: [{ sku, description, description2, unit, category, vendor,
//        vendor_sku, price_cents, retail_cents, active }] }
//
// price_cents is what A&A pays at the price level (Builder = 12% off retail). Pruett never sends its own cost.
// The key is never logged and never appears in an error message.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PruettErrorKind = "not_configured" | "disabled" | "auth" | "level_not_found" | "rate_limited" | "server" | "network" | "bad_response" | "level_not_set" | "incomplete";

export class PruettError extends Error {
  kind: PruettErrorKind;
  constructor(kind: PruettErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type PruettFeedItem = {
  sku: string;
  description: string;
  description2: string | null;
  unit: string;
  category: string | null;
  vendor: string | null;
  vendorSku: string | null;
  priceCents: number;
  retailCents: number;
  active: boolean;
};
export type PruettFeed = { level: string; generatedAt: string | null; count: number; items: PruettFeedItem[]; skippedItems: number; /** SKUs of rows skipped for a bad price: still listed by Pruett, so never deactivated because of it. */ skippedSkus: string[] };

export type PruettConfig = { baseUrl: string; key: string; level: string; timeoutMs?: number; fetch?: FetchLike };
export type PruettClient = { level: string; fetchPrices(): Promise<PruettFeed> };

export const DEFAULT_PRICE_LEVEL = "Builder";

/** Settings from the environment. Throws not_configured when the URL or key is missing, so a run is logged with a clear reason. */
export function pruettConfigFromEnv(env: Record<string, string | undefined> = process.env): Omit<PruettConfig, "fetch"> {
  // The earlier sync read PRUETT_POS_API_URL (which ended in /api) and PRUETT_POS_API_KEY. Still accepted so an environment
  // that already has them keeps working; the new names win.
  const baseUrl = env.PRUETT_FEED_URL?.trim() || env.PRUETT_POS_API_URL?.trim().replace(/\/+api\/*$/, "");
  const key = env.PRUETT_FEED_KEY?.trim() || env.PRUETT_POS_API_KEY?.trim();
  if (!baseUrl || !key) throw new PruettError("not_configured", "Pruett feed is not configured: set PRUETT_FEED_URL and PRUETT_FEED_KEY");
  return { baseUrl, key, level: env.PRUETT_PRICE_LEVEL?.trim() || DEFAULT_PRICE_LEVEL };
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** One feed row, or null when it can't be trusted (no SKU, or a price that isn't whole cents). The caller counts what it skips. */
function normalizeItem(j: unknown): PruettFeedItem | null {
  if (!j || typeof j !== "object") return null;
  const r = j as Record<string, unknown>;
  const sku = text(r.sku);
  const priceCents = cents(r.price_cents);
  const retailCents = cents(r.retail_cents);
  if (!sku || priceCents === null || retailCents === null || retailCents === 0) return null;   // a zero retail price is never real
  return {
    sku, description: text(r.description) ?? sku, description2: text(r.description2), unit: text(r.unit) ?? "",
    category: text(r.category), vendor: text(r.vendor), vendorSku: text(r.vendor_sku), priceCents, retailCents, active: r.active !== false,
  };
}

export function createPruettClient(cfg: PruettConfig): PruettClient {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = cfg.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = cfg.timeoutMs ?? 60_000;

  return {
    level: cfg.level,
    async fetchPrices() {
      const url = `${base}/api/feed/prices?${new URLSearchParams({ level: cfg.level }).toString()}`;
      let res: Response;
      try {
        res = await doFetch(url, { method: "GET", headers: { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new PruettError("network", "Could not reach Pruett POS");
      }
      if (res.status === 503) throw new PruettError("disabled", "Pruett POS has the price feed turned off (its PRICE_FEED_KEY is not set)");
      if (res.status === 404) throw new PruettError("level_not_found", `Pruett POS has no price level named ${cfg.level}`);
      if (res.status === 401 || res.status === 403) throw new PruettError("auth", `Pruett POS rejected the feed key (HTTP ${res.status})`);
      if (res.status === 429) throw new PruettError("rate_limited", "Pruett POS says too many requests (HTTP 429)");
      if (!res.ok) throw new PruettError(res.status >= 500 ? "server" : "bad_response", `Pruett POS returned HTTP ${res.status}`);

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new PruettError("bad_response", "Pruett POS sent something that is not JSON");
      }
      if (!body || typeof body !== "object") throw new PruettError("bad_response", "Unexpected response from Pruett POS");
      const b = body as Record<string, unknown>;

      // Checked before anything else: if the percent isn't set in Pruett, its prices are not what we think they are.
      if (b.level_not_set === true) throw new PruettError("level_not_set", `${cfg.level} % not set in Pruett POS`);
      if (!Array.isArray(b.items)) throw new PruettError("bad_response", "Unexpected response from Pruett POS: no items list");
      if (typeof b.level === "string" && b.level.trim().toLowerCase() !== cfg.level.toLowerCase()) {
        throw new PruettError("bad_response", `Pruett POS answered for level "${b.level}", not "${cfg.level}"`);
      }
      // A cut-off download must never look like a smaller catalog.
      if (typeof b.count === "number" && b.count !== b.items.length) {
        throw new PruettError("incomplete", `Pruett POS said ${b.count} items but sent ${b.items.length}`);
      }
      const items: PruettFeedItem[] = [];
      const skippedSkus: string[] = [];
      for (const raw of b.items) {
        const it = normalizeItem(raw);
        if (it) items.push(it);
        else {
          const sku = raw && typeof raw === "object" ? text((raw as Record<string, unknown>).sku) : null;
          if (sku) skippedSkus.push(sku);
        }
      }
      return { level: cfg.level, generatedAt: text(b.generated_at), count: b.items.length, items, skippedItems: b.items.length - items.length, skippedSkus };
    },
  };
}
