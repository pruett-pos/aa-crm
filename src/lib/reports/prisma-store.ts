import type { PrismaClient } from "../../generated/prisma/client.ts";
import { localDate } from "../commission/periods.ts";
import { STAGES, type Division } from "../rules.ts";
import type { ClaimFact, JobFact, ReportStore, SpendRow } from "./types.ts";

const WON_INDEX = STAGES.indexOf("contract_signed");
const dateStr = (d: Date) => d.toISOString().slice(0, 10);
const monthDate = (m: string) => new Date(`${m}-01T00:00:00Z`);

export function createPrismaReportStore(db: PrismaClient): ReportStore {
  return {
    async listJobFacts(): Promise<JobFact[]> {
      const [jobs, history, payments, chosenScopes] = await Promise.all([
        db.job.findMany({ orderBy: { jobNumber: "asc" } }),
        db.jobStageHistory.findMany({
          where: { toStage: { in: ["contract_signed", "in_production", "invoiced"] } },
          select: { jobId: true, toStage: true, changedAt: true }, orderBy: { changedAt: "asc" },
        }),
        db.payment.findMany({ where: { voidedAt: null }, select: { jobId: true, amountCents: true, isDeposit: true } }),
        db.scope.findMany({ where: { selected: true }, select: { jobId: true, division: true, saleCents: true } }),
      ]);
      // Sales per trade: the chosen package of each trade on each job.
      const byTrade = new Map<string, Record<string, number>>();
      for (const s of chosenScopes) byTrade.set(s.jobId, { ...(byTrade.get(s.jobId) ?? {}), [s.division]: Number(s.saleCents) });

      // First time each job entered each stage (rows are oldest first).
      const first = new Map<string, string>();
      for (const h of history) {
        const key = `${h.jobId}|${h.toStage}`;
        if (!first.has(key)) first.set(key, localDate(h.changedAt));
      }
      const collected = new Map<string, number>();
      const deposits = new Map<string, number>();
      for (const p of payments) {
        collected.set(p.jobId, (collected.get(p.jobId) ?? 0) + Number(p.amountCents));
        if (p.isDeposit) deposits.set(p.jobId, (deposits.get(p.jobId) ?? 0) + Number(p.amountCents));
      }

      return jobs.map((j) => {
        const createdDate = localDate(j.createdAt);
        const stageIndex = STAGES.indexOf(j.stage as (typeof STAGES)[number]);
        // Won = the job reached a signed contract or later. Jobs from before stage history existed fall back to their created date.
        const isWon = stageIndex >= WON_INDEX;
        return {
          jobId: j.id, jobNumber: j.jobNumber, jobType: j.jobType, divisions: j.divisions as Division[], source: j.source,
          estimatorId: j.estimatorId, stage: j.stage, createdDate,
          contractCents: j.contractCents === null ? null : Number(j.contractCents),
          divisionSalesCents: byTrade.get(j.id),
          wonDate: isWon ? first.get(`${j.id}|contract_signed`) ?? createdDate : null,
          inProductionDate: first.get(`${j.id}|in_production`) ?? null,
          installDate: j.installDate ? dateStr(j.installDate) : null,
          invoicedDate: first.get(`${j.id}|invoiced`) ?? null,
          collectedCents: collected.get(j.id) ?? 0,
          depositRequiredCents: Number(j.depositRequiredCents),
          depositPaidCents: deposits.get(j.id) ?? 0,
        };
      });
    },

    async listSpend(fromMonth, toMonth): Promise<SpendRow[]> {
      const rows = await db.marketingSpend.findMany({ where: { month: { gte: monthDate(fromMonth), lte: monthDate(toMonth) } } });
      return rows.map((r) => ({ source: r.source, month: dateStr(r.month).slice(0, 7), spendCents: Number(r.spendCents) }));
    },

    async listClaims(): Promise<ClaimFact[]> {
      const claims = await db.insuranceClaim.findMany();
      if (claims.length === 0) return [];
      const jobs = await db.job.findMany({ where: { id: { in: claims.map((c) => c.jobId) } } });
      return claims.flatMap((c) => {
        const j = jobs.find((x) => x.id === c.jobId);
        if (!j) return [];
        return [{
          jobId: c.jobId, jobNumber: j.jobNumber, divisions: j.divisions as Division[], estimatorId: j.estimatorId,
          carrier: c.carrier, claimNumber: c.claimNumber, depreciationCents: Number(c.depreciationCents ?? 0),
          depreciationReceivedAt: c.depreciationReceivedAt ? c.depreciationReceivedAt.toISOString() : null,
        }];
      });
    },

    async estimatorNames() {
      const us = await db.user.findMany({ where: { role: "estimator" } });
      return Object.fromEntries(us.map((u) => [u.id, u.fullName]));
    },

    async pmDivisions(userId) {
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return [];
      const rows = await db.divisionManager.findMany({ where: { userId } });
      return [...new Set(rows.map((r) => r.division as Division))];
    },
  };
}
