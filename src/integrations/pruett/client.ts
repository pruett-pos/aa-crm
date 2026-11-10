// Thin client for Pruett POS's read-only price feed: GET <PRUETT_POS_API_URL>/feed/prices?level=Builder
// Auth is a bearer key (PRUETT_POS_API_KEY = the POS's PRICE_FEED_KEY). Everything Pruett-specific lives in this folder.
// The feed never carries Pruett's cost. We read only retail_cents: what A&A pays (Builder, retail - 12%) is worked out in
// rules.ts, the one place for money math, so price_cents from the feed is checked but never stored.
import { z } from "zod";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PruettErrorKind = "not_configured" | "disabled" | "auth" | "level_not_found" | "server" | "network" | "bad_response";

export class PruettError extends Error {
  kind: PruettErrorKind;
  constructor(kind: PruettErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type PruettConfig = { baseUrl: string; apiKey: string; timeoutMs?: number; fetch?: FetchLike };

/** Configuration from the environment, or null when no key is set (the sync then stays off). */
export function pruettConfigFromEnv(env: Record<string, string | undefined> = process.env): Pick<PruettConfig, "baseUrl" | "apiKey"> | null {
  const apiKey = env.PRUETT_POS_API_KEY?.trim();
  const baseUrl = env.PRUETT_POS_API_URL?.trim().replace(/\/+$/, "");
  if (!apiKey || !baseUrl) return null;
  return { baseUrl, apiKey };
}

const feedItem = z.object({
  sku: z.string().min(1),
  description: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  price_cents: z.number().int().nonnegative(),
  retail_cents: z.number().int().positive(),
  active: z.boolean(),
});
const feedBody = z.object({
  level: z.string(),
  level_not_set: z.boolean(),
  generated_at: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(feedItem),
});

export type PruettFeedItem = { sku: string; description: string | null; unit: string | null; retailCents: number };
export type PruettFeed = { level: string; levelNotSet: boolean; generatedAt: string; items: PruettFeedItem[] };

export async function fetchPruettPrices(cfg: PruettConfig, level = "Builder"): Promise<PruettFeed> {
  const doFetch = cfg.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${cfg.baseUrl}/feed/prices?level=${encodeURIComponent(level)}`, {
      headers: { authorization: `Bearer ${cfg.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });
  } catch (e) {
    throw new PruettError("network", `Could not reach Pruett POS: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 503) throw new PruettError("disabled", "Pruett POS has the price feed turned off (PRICE_FEED_KEY is not set there)");
  if (res.status === 401) throw new PruettError("auth", "Pruett POS rejected the key. Check PRUETT_POS_API_KEY matches PRICE_FEED_KEY in Pruett POS");
  if (res.status === 404) throw new PruettError("level_not_found", `Pruett POS has no price level named ${level}`);
  if (!res.ok) throw new PruettError("server", `Pruett POS answered ${res.status}`);

  const parsed = feedBody.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new PruettError("bad_response", "Pruett POS sent a price feed in a shape we do not recognise");
  const body = parsed.data;
  if (body.items.length !== body.count) throw new PruettError("bad_response", "The price feed's count does not match its items (cut off?)");
  if (body.level.toLowerCase() !== level.toLowerCase()) throw new PruettError("bad_response", `Asked for ${level} but the feed is for ${body.level}`);
  return {
    level: body.level,
    levelNotSet: body.level_not_set,
    generatedAt: body.generated_at,
    items: body.items.filter((i) => i.active).map((i) => ({ sku: i.sku.trim(), description: i.description ?? null, unit: i.unit ?? null, retailCents: i.retail_cents })),
  };
}
