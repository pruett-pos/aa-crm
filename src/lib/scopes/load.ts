import type { AuthUser } from "../auth/store.ts";
import { canReadScopes, canWriteScopes, toView, type ScopeView } from "./service.ts";
import type { ScopeStore } from "./types.ts";

export type CatalogItem = { id: string; name: string; unit: string; specialOrder: boolean; retailCents: number };

export type ScopePageData =
  | { status: "not_found" }
  | { status: "forbidden" }
  | {
      status: "ok";
      job: { id: string; jobNumber: number };
      canEdit: boolean;
      products: CatalogItem[];   // only sent to people who can edit (they may see cost)
      scopes: ScopeView[];
      /** The trades on this job, in order. */
      divisions: string[];
      viewerRole: AuthUser["role"];
      /** The estimator's own-truck flag, only for people who may see commission; otherwise null. */
      commissionOwnTruck: boolean | null;
    };

/** One place that decides what a user may see of a job's scopes; used by the page and the API. */
export async function loadScopeData(store: ScopeStore, user: AuthUser, jobId: string): Promise<ScopePageData> {
  const job = await store.getJob(jobId);
  if (!job) return { status: "not_found" };
  const managerIds = await store.divisionManagerIds(job.divisions);
  if (!canReadScopes(user, job, managerIds)) return { status: "forbidden" };

  const estimatorOwnTruck = job.estimatorId ? await store.getEstimatorOwnTruck(job.estimatorId) : false;
  const canEdit = canWriteScopes(user, job);
  // A Production Manager only sees the trades they manage.
  const pmDivisions = user.role === "production_manager" ? await store.divisionsManagedBy(user.id) : null;
  const [allScopes, catalog, summary] = await Promise.all([
    store.listScopes(job.id),
    canEdit ? store.listProducts() : Promise.resolve([]),
    store.listJobs().then((js) => js.find((j) => j.id === job.id)),
  ]);
  return {
    status: "ok",
    job: { id: job.id, jobNumber: summary?.jobNumber ?? 0 },
    canEdit,
    viewerRole: user.role,
    commissionOwnTruck:
      user.role === "admin" || (user.role === "estimator" && job.estimatorId === user.id)
        ? estimatorOwnTruck
        : null,
    products: catalog.map((p) => ({
      id: p.id, name: p.name, unit: p.unit, specialOrder: p.specialOrder, retailCents: p.retailCents,
    })),
    divisions: pmDivisions ? job.divisions.filter((d) => pmDivisions.includes(d)) : job.divisions,
    scopes: allScopes.filter((s) => !pmDivisions || pmDivisions.includes(s.division)).map((s) => toView(s, user.role, {
      isOwnJobEstimator: job.estimatorId === user.id, estimatorOwnTruck,
    })),
  };
}
