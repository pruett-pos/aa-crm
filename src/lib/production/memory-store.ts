import type { Division, Stage } from "../rules.ts";
import type { StoredScope } from "../scopes/types.ts";
import type {
  JobStageOrClosed, ProductEntry, ProductionJob, ProductionStore, ProductionTx, ScheduleItem, TradePatch, TradeRow,
} from "./types.ts";

/** In-memory store for tests. Not used by the app. */
export class MemoryProductionStore implements ProductionStore {
  jobs: ProductionJob[] = [];
  trades: (TradeRow & { jobId: string })[] = [];
  pm = new Map<string, Division[]>();
  crew: { id: string; fullName: string }[] = [];
  chosen: (StoredScope & { jobId: string })[] = [];
  products: ProductEntry[] = [];
  events: { jobId: string; division: Division | null; actorId: string; action: string; detail?: string }[] = [];
  history: { jobId: string; from: JobStageOrClosed; to: Stage; by: string }[] = [];
  installDates = new Map<string, string | null>();

  async getJob(jobId: string) { return this.jobs.find((j) => j.id === jobId) ?? null; }
  async listTrades(jobId: string) { return this.trades.filter((t) => t.jobId === jobId).map(({ jobId: _j, ...t }) => t); }
  async pmDivisions(userId: string) { return this.pm.get(userId) ?? []; }
  async listCrewLeaders() { return this.crew; }
  async isActiveCrewLeader(id: string) { return this.crew.some((c) => c.id === id); }
  async getChosenScopes(jobId: string) { return this.chosen.filter((s) => s.jobId === jobId && s.selected); }
  async listProducts() { return this.products; }

  private item(j: ProductionJob, division: Division): ScheduleItem {
    const t = this.trades.find((x) => x.jobId === j.id && x.division === division);
    return {
      jobId: j.id, jobNumber: j.jobNumber, division, status: t?.status ?? "not_scheduled", installDate: t?.installDate ?? null,
      crewLeaderId: t?.crewLeaderId ?? null, crewLeaderName: this.crew.find((c) => c.id === t?.crewLeaderId)?.fullName ?? null,
      customerName: j.customerName, propertyAddress: j.propertyAddress, estimatorId: j.estimatorId,
    };
  }
  async listSchedule(range: { from: string; to: string }) {
    return this.jobs.flatMap((j) => j.divisions.map((d) => this.item(j, d)))
      .filter((i) => i.installDate !== null && i.installDate >= range.from && i.installDate <= range.to && i.status !== "not_scheduled");
  }
  async listOpenTrades() {
    return this.jobs
      .filter((j) => j.contractSigned && j.stage !== "lost" && j.stage !== "cancelled_after_approval")
      .flatMap((j) => j.divisions.map((d) => this.item(j, d)))
      .filter((i) => i.status === "not_scheduled" || i.status === "proposed");
  }

  async transaction<T>(jobId: string, fn: (tx: ProductionTx) => Promise<T>): Promise<T> {
    const self = this;
    const snap = {
      jobs: self.jobs.map((j) => ({ ...j })), trades: self.trades.map((t) => ({ ...t })), chosen: self.chosen.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) })),
      events: [...self.events], history: [...self.history], installDates: new Map(self.installDates),
    };
    const tx: ProductionTx = {
      getJob: () => self.getJob(jobId),
      listTrades: () => self.listTrades(jobId),
      async upsertTrade(division, patch: TradePatch) {
        const existing = self.trades.find((t) => t.jobId === jobId && t.division === division);
        if (existing) Object.assign(existing, patch);
        else self.trades.push({
          jobId, division, status: "not_scheduled", installDate: null, crewLeaderId: null, crewLeaderName: null,
          proposedBy: null, confirmedBy: null, startedAt: null, completedAt: null, notes: null, ...patch,
        });
        const t = self.trades.find((x) => x.jobId === jobId && x.division === division)!;
        t.crewLeaderName = self.crew.find((c) => c.id === t.crewLeaderId)?.fullName ?? null;
      },
      async logEvent(e) { self.events.push({ jobId, ...e }); },
      async setStage(from, to, actorId) {
        const j = self.jobs.find((x) => x.id === jobId)!;
        j.stage = to;
        self.history.push({ jobId, from, to, by: actorId });
      },
      async setMaterialsOrder(at, _by, po) {
        const j = self.jobs.find((x) => x.id === jobId)!;
        j.materialsOrderedAt = at;
        j.poReference = po;
      },
      async setJobInstallDate(date) { self.installDates.set(jobId, date); },
      async chosenMaterialItemIds() {
        const ids = new Set<string>();
        for (const s of self.chosen) if (s.jobId === jobId && s.selected) {
          s.items.forEach((i, idx) => { if (i.kind === "material") ids.add(i.id ?? `${s.id}:${idx}`); });
        }
        return ids;
      },
      async setColors(items) {
        for (const { itemId, color } of items) {
          for (const s of self.chosen.filter((x) => x.jobId === jobId)) {
            s.items.forEach((i, idx) => { if ((i.id ?? `${s.id}:${idx}`) === itemId) i.color = color; });
          }
        }
      },
      async crewConflicts(crewLeaderId, date, except) {
        return self.trades
          .filter((t) => t.crewLeaderId === crewLeaderId && t.installDate === date && (t.status === "scheduled" || t.status === "in_production")
            && !(t.jobId === except.jobId && t.division === except.division))
          .map((t) => ({ jobNumber: self.jobs.find((j) => j.id === t.jobId)?.jobNumber ?? 0, division: t.division }));
      },
    };
    try {
      return await fn(tx);
    } catch (e) {
      Object.assign(self, snap);
      throw e;
    }
  }
}
