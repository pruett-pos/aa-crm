import { getDb } from "../db.ts";
import { createGoogleSolarClient, googleSolarConfigFromEnv, type GoogleSolarClient } from "../../integrations/google-solar/client.ts";
import { getAssemblyStore } from "../estimating/index.ts";
import { getScopeStore } from "../scopes/index.ts";
import { ballpark, fetchEstimateForJob, panelState, type AerialPanelView } from "./logic.ts";
import { createPrismaAerialStore } from "./prisma-store.ts";
import type { AerialJob, AerialStore } from "./types.ts";

const g = globalThis as unknown as { __aaAerialStore?: AerialStore; __aaGoogleSolar?: GoogleSolarClient | null };

export function getAerialStore(): AerialStore {
  return (g.__aaAerialStore ??= createPrismaAerialStore(getDb()));
}

/** The Google client, or null when GOOGLE_MAPS_API_KEY is not set (nothing is fetched then). */
export function getGoogleSolarClient(): GoogleSolarClient | null {
  if (g.__aaGoogleSolar !== undefined) return g.__aaGoogleSolar;
  const cfg = googleSolarConfigFromEnv();
  g.__aaGoogleSolar = cfg
    ? createGoogleSolarClient({
      ...cfg,
      // Call records hold the endpoint name and result only: never the key, an address or coordinates.
      log: async (e) => {
        await getDb().integrationEvent.create({
          data: { system: "google_solar", direction: "out", status: e.status, payload: (e.payload ?? undefined) as never, error: e.error ?? null },
        });
      },
    })
    : null;
  return g.__aaGoogleSolar;
}

/**
 * Fire and forget, called after a lead with an appointment is saved. The booking never waits for Google and never
 * fails because of it: fetchEstimateForJob never throws and records "No aerial data" on the property instead.
 */
export function fetchAerialBestEffort(jobId: string): void {
  void fetchEstimateForJob({ store: getAerialStore(), client: getGoogleSolarClient() }, jobId).catch(() => undefined);
}

/** What the aerial panel shows for a job: the property's estimate and, when roofing is on the job, the ballpark prices. */
export async function loadAerialPanel(job: AerialJob): Promise<AerialPanelView> {
  const store = getAerialStore();
  const [estimate, settings] = await Promise.all([store.getEstimate(job.propertyId), store.getSettings()]);
  let prices = null;
  if (estimate?.status === "ok" && estimate.roofAreaSqft && estimate.rawAreaSqft && job.divisions.includes("roofing")) {
    prices = ballpark({
      estimate: { roofAreaSqft: estimate.roofAreaSqft, rawAreaSqft: estimate.rawAreaSqft, segments: estimate.segments ?? [], segmentCount: estimate.segmentCount ?? 0 },
      settings, lines: await getAssemblyStore().list(), products: await getScopeStore().listProducts(),
    });
  }
  return { propertyId: job.propertyId, state: panelState(estimate, settings.enabled), estimate, ballpark: prices };
}
