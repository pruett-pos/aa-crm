import { HoverError, type HoverJob } from "../../integrations/hover/client.ts";
import { sameAddress } from "../companycam/address.ts";
import type { Actor } from "../production/types.ts";
import { STAGES } from "../rules.ts";
import { MeasurementError, describeShape, parseHoverMeasurements, squares, validateMeasurements } from "./parse.ts";
import type { MeasurementJob, MeasurementRecord, MeasurementStore, Measurements } from "./types.ts";

/** The slice of the Hover client this module needs (so tests can fake it). */
export interface HoverSource {
  listJobs(search: string): Promise<HoverJob[]>;
  getMeasurements(modelId: string): Promise<unknown>;
}

const SIGNED = STAGES.indexOf("contract_signed");

// ---------- Rights ----------
/** Admin and the job's own estimator can enter or import measurements, until the contract is signed. */
export function canEditMeasurements(actor: Actor, job: Pick<MeasurementJob, "estimatorId">): boolean {
  return actor.role === "admin" || (actor.role === "estimator" && job.estimatorId === actor.id);
}
/** Viewing: the same people, plus a Production Manager with a trade on the job. */
export function canViewMeasurements(actor: Actor, job: Pick<MeasurementJob, "estimatorId" | "divisions">, pm: readonly string[]): boolean {
  return canEditMeasurements(actor, job) || (actor.role === "production_manager" && job.divisions.some((d) => pm.includes(d)));
}
/** Measurements can change until the contract is signed (the scope and contract are built from them); never on a closed job. */
export const measurementsLocked = (job: Pick<MeasurementJob, "stage">): boolean =>
  job.stage === "lost" || job.stage === "cancelled_after_approval" || STAGES.indexOf(job.stage) >= SIGNED;

// ---------- View ----------
export type MeasurementRow = Measurements & {
  id: string; source: "hover" | "manual"; createdAt: string; note: string | null;
  /** Roofing squares (area / 100), and squares with 5, 10, 15 and 20 percent waste. */
  squares: number; wasteSquares: { pct: number; squares: number }[];
};
export type MeasurementView = {
  job: { id: string; jobNumber: number; address: string; divisions: string[] };
  canEdit: boolean;
  locked: boolean;
  current: MeasurementRow | null;
  history: MeasurementRow[];
};

const WASTE = [5, 10, 15, 20] as const;
export const toRow = (r: MeasurementRecord): MeasurementRow => ({
  id: r.id, source: r.source, createdAt: r.createdAt.toISOString(), note: r.note,
  roofAreaSqft: r.roofAreaSqft, facets: r.facets, pitches: r.pitches, ridgesHipsFt: r.ridgesHipsFt, valleysFt: r.valleysFt, rakesFt: r.rakesFt,
  eavesFt: r.eavesFt, flashingFt: r.flashingFt, stepFlashingFt: r.stepFlashingFt, sidingAreaSqft: r.sidingAreaSqft,
  squares: squares(r.roofAreaSqft),
  wasteSquares: WASTE.map((pct) => ({ pct, squares: Math.round(r.roofAreaSqft * (1 + pct / 100)) / 100 })),
});

async function load(store: MeasurementStore, actor: Actor, jobId: string): Promise<{ job: MeasurementJob; pm: string[] }> {
  const job = await store.getJob(jobId);
  if (!job) throw new MeasurementError("not_found");
  const pm = await store.pmDivisions(actor.id);
  if (!canViewMeasurements(actor, job, pm)) throw new MeasurementError("forbidden");
  return { job, pm };
}

export async function measurementView(store: MeasurementStore, actor: Actor, jobId: string): Promise<MeasurementView> {
  const { job } = await load(store, actor, jobId);
  const all = await store.list(jobId);
  return {
    job: { id: job.id, jobNumber: job.jobNumber, address: `${job.street}, ${job.city} ${job.zip}`, divisions: job.divisions },
    canEdit: canEditMeasurements(actor, job) && !measurementsLocked(job),
    locked: measurementsLocked(job),
    current: all[0] ? toRow(all[0]) : null,
    history: all.slice(1, 11).map(toRow),
  };
}

async function loadForEdit(store: MeasurementStore, actor: Actor, jobId: string): Promise<MeasurementJob> {
  const { job } = await load(store, actor, jobId);
  if (!canEditMeasurements(actor, job)) throw new MeasurementError("forbidden");
  if (measurementsLocked(job)) throw new MeasurementError("locked");
  return job;
}

// ---------- Typed in ----------
export async function saveManualMeasurements(store: MeasurementStore, actor: Actor, jobId: string, values: Measurements, note?: string | null): Promise<MeasurementRow> {
  const job = await loadForEdit(store, actor, jobId);
  const m = validateMeasurements(values);
  const rec = await store.insert(job.id, { ...m, source: "manual", hoverJobId: null, hoverModelId: null, raw: null, note: note?.trim().slice(0, 300) || null, createdBy: actor.id });
  return toRow(rec);
}

// ---------- From Hover ----------
export type HoverCandidate = {
  hoverJobId: string; name: string | null; address: string; state: string;
  /** Same street and zip as the CRM job. */
  addressMatches: boolean;
  /** The newest finished model, or null when none is ready yet. */
  readyModelId: string | null;
};

function hoverFailure(e: unknown): never {
  if (e instanceof HoverError) {
    if (e.kind === "auth") throw new MeasurementError("hover_not_connected", "Hover needs to be connected again");
    throw new MeasurementError("hover_error", "Hover isn't responding. Try again in a minute.", e.kind);
  }
  throw e;
}

const addressText = (a: HoverJob["address"]) => [a.street, a.city, a.state, a.postalCode].filter(Boolean).join(", ");

/** Find the property in Hover. The search text defaults to the job's street; Hover needs at least 3 characters. */
export async function searchHover(store: MeasurementStore, hover: HoverSource | null, actor: Actor, jobId: string, query?: string | null): Promise<HoverCandidate[]> {
  const job = await loadForEdit(store, actor, jobId);
  if (!hover) throw new MeasurementError("hover_not_connected", "Hover isn't connected");
  const q = (query?.trim() || job.street).slice(0, 100);
  if (q.length < 3) throw new MeasurementError("search_too_short");
  let jobs: HoverJob[];
  try {
    jobs = await hover.listJobs(q);
  } catch (e) {
    return hoverFailure(e);
  }
  return jobs.map((h): HoverCandidate => ({
    hoverJobId: h.id, name: h.name, address: addressText(h.address), state: h.state,
    addressMatches: sameAddress({ street: h.address.street, postalCode: h.address.postalCode }, { street: job.street, zip: job.zip }),
    readyModelId: h.state === "completed" ? [...h.models].reverse().find((m) => m.state === "complete")?.id ?? null : null,
  })).sort((a, b) => Number(b.addressMatches) - Number(a.addressMatches));
}

/**
 * Pull a finished Hover model's measurements into the job. The chosen job and model are checked against a fresh search,
 * so only a model Hover itself lists for that search can be imported.
 */
export async function importHoverMeasurements(
  store: MeasurementStore, hover: HoverSource | null, actor: Actor,
  a: { jobId: string; hoverJobId: string; modelId: string; query?: string | null },
): Promise<MeasurementRow> {
  const job = await loadForEdit(store, actor, a.jobId);
  if (!hover) throw new MeasurementError("hover_not_connected", "Hover isn't connected");
  const q = (a.query?.trim() || job.street).slice(0, 100);
  if (q.length < 3) throw new MeasurementError("search_too_short");
  let found: HoverJob | undefined;
  try {
    found = (await hover.listJobs(q)).find((h) => h.id === a.hoverJobId);
  } catch (e) {
    return hoverFailure(e);
  }
  if (!found) throw new MeasurementError("no_match", "That Hover job wasn't found");
  const model = found.models.find((m) => m.id === a.modelId);
  if (!model) throw new MeasurementError("no_match", "That Hover model wasn't found on the job");
  if (found.state !== "completed" || model.state !== "complete") throw new MeasurementError("model_not_ready", "Hover hasn't finished that model yet");

  let raw: unknown;
  try {
    raw = await hover.getMeasurements(model.id);
  } catch (e) {
    return hoverFailure(e);
  }
  let m;
  try {
    m = parseHoverMeasurements(raw);
  } catch (e) {
    // So a response shape we did not expect can be fixed from the logs. Field names and numbers only, no strings.
    console.error(`hover measurements could not be read (${e instanceof Error ? e.message : "unknown"}); shape: ${describeShape(raw).slice(0, 3000)}`);
    throw e;
  }
  const rec = await store.insert(job.id, { ...m, source: "hover", hoverJobId: found.id, hoverModelId: model.id, raw, note: null, createdBy: actor.id });
  return toRow(rec);
}
