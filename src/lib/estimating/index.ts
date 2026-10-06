import { getDb } from "../db.ts";
import { getContractStore } from "../contracts/index.ts";
import { getMeasurementStore } from "../measurements/index.ts";
import { getScopeStore } from "../scopes/index.ts";
import { createPrismaAssemblyStore } from "./prisma-store.ts";
import type { AssemblyStore, EstimatingDeps } from "./service.ts";

const g = globalThis as unknown as { __aaAssemblyStore?: AssemblyStore };

export function getAssemblyStore(): AssemblyStore {
  return (g.__aaAssemblyStore ??= createPrismaAssemblyStore(getDb()));
}

export function getEstimatingDeps(): EstimatingDeps {
  return { scopes: getScopeStore(), measurements: getMeasurementStore(), assemblies: getAssemblyStore(), contracts: getContractStore() };
}
