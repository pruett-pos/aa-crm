import type { AuthUser } from "../auth/store.ts";
import type { MeasurementStore } from "../measurements/types.ts";
import { SCOPE_DEFAULT_TARGET_MARGIN_BPS, type Division } from "../rules.ts";
import { ScopeInputError, canWriteScopes, computeScope } from "../scopes/service.ts";
import { TIERS, type ScopeStore, type Tier } from "../scopes/types.ts";
import { buildRoofingTiers, type AssemblyLine, type SkippedLine } from "./assemblies.ts";
import { LABOR_ROLES, MATERIAL_ROLES, isLaborRole, isMaterialRole } from "./roofing.ts";

export type EstimatingErrorCode =
  | "not_found" | "forbidden" | "contract_signed" | "no_measurements" | "division_not_supported" | "invalid_waste"
  | "scope_exists" | "no_assembly" | "invalid_scope" | "invalid_assembly";

export class EstimatingError extends Error {
  code: EstimatingErrorCode;
  /** For no_assembly: what was left out and why. */
  skipped: SkippedLine[];
  constructor(code: EstimatingErrorCode, message?: string, skipped: SkippedLine[] = []) {
    super(message ?? code);
    this.code = code;
    this.skipped = skipped;
  }
}

// ---------- Assembly settings ----------
export type AssemblyEdit = {
  tier: Tier; role: string; productId: string | null; description: string | null; unit: string | null;
  coverage: number | null; unitCostCents: number | null; enabled: boolean; sortOrder?: number;
};

export interface AssemblyStore {
  list(): Promise<AssemblyLine[]>;
  /** Create or update the row for (tier, role). */
  upsert(edit: AssemblyEdit & { kind: "material" | "labor" }, userId: string): Promise<void>;
}

const MAX_COVERAGE = 100_000;
const MAX_RATE_CENTS = 100_000_000;

/** Check one row of the assembly settings. Returns the row with its kind worked out from the role. */
export function validateAssemblyEdit(e: AssemblyEdit, knownProductIds: ReadonlySet<string>): AssemblyEdit & { kind: "material" | "labor" } {
  const bad = (m: string): never => { throw new EstimatingError("invalid_assembly", m); };
  if (!(TIERS as readonly string[]).includes(e.tier)) bad("Unknown package tier");
  const kind = isMaterialRole(e.role) ? "material" : isLaborRole(e.role) ? "labor" : bad("Unknown role");
  if (e.coverage !== null && !(Number.isFinite(e.coverage) && e.coverage > 0 && e.coverage <= MAX_COVERAGE)) bad("Coverage must be more than zero");
  if (e.unitCostCents !== null && !(Number.isInteger(e.unitCostCents) && e.unitCostCents >= 0 && e.unitCostCents <= MAX_RATE_CENTS)) bad("Enter a valid rate");
  const description = e.description?.trim() || null;
  if (description && description.length > 200) bad("The description is too long");
  const unit = e.unit?.trim().toLowerCase() || null;
  if (unit && !/^[a-z]{1,8}$/.test(unit)) bad("The unit should be 1 to 8 letters, like sq or lf");
  if (kind === "material") {
    if (e.productId !== null && !knownProductIds.has(e.productId)) bad("Pick a product from the catalog");
    return { ...e, kind, description: null, unit: null, unitCostCents: null };
  }
  if (e.productId !== null) bad("A labor line has no catalog product");
  return { ...e, kind, description, unit, coverage: null, productId: null };
}

export const ASSEMBLY_ROLES = { material: MATERIAL_ROLES, labor: LABOR_ROLES } as const;

// ---------- Build the scopes ----------
export type EstimatingDeps = {
  scopes: ScopeStore;
  measurements: MeasurementStore;
  assemblies: AssemblyStore;
  contracts: {
    hasSignedContract(jobId: string): Promise<boolean>;
    clearSelectionIfSelected(jobId: string, division: Division, tier: Tier): Promise<void>;
  };
};

export type BuildResult = { tiers: { tier: Tier; title: string; lineCount: number }[]; skipped: SkippedLine[]; replaced: boolean };

/**
 * Start a trade's package scopes from the job's current measurements and the assembly settings. Goes through the same
 * pricing as a hand-built scope (catalog cost, target margin, role checks). Existing hand-built work is only replaced
 * when the caller says so; replacing the package a customer picked clears that choice, exactly as editing it would.
 */
export async function buildScopesFromMeasurements(
  deps: EstimatingDeps, user: AuthUser, a: { jobId: string; division: string; wastePct: number; replace: boolean },
): Promise<BuildResult> {
  const job = await deps.scopes.getJob(a.jobId);
  if (!job) throw new EstimatingError("not_found");
  if (!canWriteScopes(user, job)) throw new EstimatingError("forbidden");
  if (a.division !== "roofing") throw new EstimatingError("division_not_supported", "Only roofing can be built from measurements so far");
  if (!job.divisions.includes("roofing")) throw new EstimatingError("division_not_supported", "Roofing isn't on this job");
  if (!Number.isFinite(a.wastePct) || a.wastePct < 0 || a.wastePct > 30) throw new EstimatingError("invalid_waste");
  if (await deps.contracts.hasSignedContract(job.id)) throw new EstimatingError("contract_signed");

  const current = (await deps.measurements.list(job.id))[0];
  if (!current) throw new EstimatingError("no_measurements");

  const existing = (await deps.scopes.listScopes(job.id)).filter((s) => s.division === "roofing" && s.items.length > 0);
  if (existing.length > 0 && !a.replace) throw new EstimatingError("scope_exists");

  const { tiers, skipped } = buildRoofingTiers({ measurements: current, wastePct: a.wastePct, lines: await deps.assemblies.list(), products: await deps.scopes.listProducts() });
  if (tiers.length === 0) throw new EstimatingError("no_assembly", "The roofing assembly settings don't have anything to build from yet", skipped);

  // Compute every tier first, so a problem in one leaves the existing scopes untouched.
  const products = await deps.scopes.listProducts();
  const computed = tiers.map((t) => {
    try {
      return computeScope({ division: "roofing", tier: t.tier, title: t.title, targetMarginBps: SCOPE_DEFAULT_TARGET_MARGIN_BPS, items: t.items }, products, job.divisions);
    } catch (e) {
      if (e instanceof ScopeInputError) throw new EstimatingError("invalid_scope", `${t.tier}: ${e.message}`, skipped);
      throw e;
    }
  });
  for (const scope of computed) {
    await deps.scopes.saveScope(job.id, scope);
    await deps.contracts.clearSelectionIfSelected(job.id, "roofing", scope.tier);
  }
  return { tiers: computed.map((s) => ({ tier: s.tier, title: s.title, lineCount: s.items.length })), skipped, replaced: existing.length > 0 };
}
