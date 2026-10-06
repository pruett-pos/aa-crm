import { getDb } from "../db.ts";
import { createHoverClient, type HoverClient } from "../../integrations/hover/client.ts";
import { hoverOAuthFromEnv, type HoverOAuthConfig } from "../../integrations/hover/oauth.ts";
import { createPrismaHoverTokenStore } from "./prisma-store.ts";
import { createHoverTokenProvider, type HoverTokenStore } from "./tokens.ts";

const g = globalThis as unknown as { __aaHoverTokens?: HoverTokenStore; __aaHoverClient?: HoverClient | null };

export function getHoverTokenStore(): HoverTokenStore {
  return (g.__aaHoverTokens ??= createPrismaHoverTokenStore(getDb(), () => process.env.INTEGRATION_KEY));
}

export const getHoverOAuthConfig = (): HoverOAuthConfig | null => hoverOAuthFromEnv();

/** The Hover client, or null when Hover credentials aren't configured (the feature then just shows "not connected"). */
export function getHoverClient(): HoverClient | null {
  if (g.__aaHoverClient !== undefined) return g.__aaHoverClient;
  const oauth = hoverOAuthFromEnv();
  g.__aaHoverClient = oauth
    ? createHoverClient({
      baseUrl: oauth.baseUrl,
      getAccessToken: createHoverTokenProvider({ store: getHoverTokenStore(), oauth, fetch: (u, i) => fetch(u, i) }),
      // Call records hold the endpoint and result only: never a token, an address or a name.
      log: async (e) => {
        await getDb().integrationEvent.create({
          data: { system: "hover", direction: "out", status: e.status, payload: (e.payload ?? undefined) as never, error: e.error ?? null },
        });
      },
    })
    : null;
  return g.__aaHoverClient;
}
