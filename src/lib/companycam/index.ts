import { getDb } from "../db.ts";
import { companyCamConfigFromEnv, createCompanyCamClient, type CompanyCamClient } from "../../integrations/companycam/client.ts";
import { ensureProject } from "./logic.ts";
import { createPrismaCompanyCamStore } from "./prisma-store.ts";
import type { CompanyCamStore } from "./types.ts";

const g = globalThis as unknown as { __aaCcStore?: CompanyCamStore; __aaCcClient?: CompanyCamClient | null };

export function getCompanyCamStore(): CompanyCamStore {
  return (g.__aaCcStore ??= createPrismaCompanyCamStore(getDb()));
}

/** The CompanyCam client (current public API), or null when no access token is configured (the feature then just shows "not connected"). */
export function getCompanyCamClient(): CompanyCamClient | null {
  if (g.__aaCcClient !== undefined) return g.__aaCcClient;
  const cfg = companyCamConfigFromEnv();
  g.__aaCcClient = cfg
    ? createCompanyCamClient({
      ...cfg,
      // Call records hold the endpoint and result only: never the token, an address or a name.
      log: async (e) => {
        await getDb().integrationEvent.create({
          data: { system: "companycam", direction: "out", status: e.status, payload: (e.payload ?? undefined) as never, error: e.error ?? null },
        });
      },
    })
    : null;
  return g.__aaCcClient;
}

/**
 * Fire and forget, called after a lead is saved. The lead never waits for CompanyCam and never fails because of it:
 * ensureProject records any failure on the job for a retry.
 */
export function ensureProjectBestEffort(jobId: string): void {
  void ensureProject(getCompanyCamStore(), getCompanyCamClient(), jobId).catch(() => undefined);
}
