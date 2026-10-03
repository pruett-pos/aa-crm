import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Division } from "../rules.ts";
import type { CcJob, CcLinkMethod, CcStatus, CompanyCamStore } from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;

type Row = {
  id: string; jobNumber: number; stage: string; needsReview: boolean; divisions: string[]; estimatorId: string | null;
  companycamProjectId: string | null; companycamProjectUrl: string | null; companycamStatus: string; companycamLinkMethod: string | null;
  companycamAttempts: number; companycamNextAttemptAt: Date | null; companycamError: string | null;
  property: { street: string; city: string; state: string; zip: string; customer: { firstName: string; lastName: string } };
};
const toJob = (r: Row): CcJob => ({
  id: r.id, jobNumber: r.jobNumber, stage: r.stage, needsReview: r.needsReview,
  firstName: r.property.customer.firstName, lastName: r.property.customer.lastName,
  street: r.property.street, city: r.property.city, state: r.property.state, zip: r.property.zip,
  divisions: r.divisions as Division[], estimatorId: r.estimatorId,
  status: r.companycamStatus as CcStatus, projectId: r.companycamProjectId, projectUrl: r.companycamProjectUrl,
  linkMethod: r.companycamLinkMethod as CcLinkMethod | null, attempts: r.companycamAttempts,
  nextAttemptAt: r.companycamNextAttemptAt, error: r.companycamError,
});
const include = { property: { include: { customer: true } } } as const;

const isUniqueViolation = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === "P2002" || /unique constraint/i.test(x?.message ?? "");
};

export function createPrismaCompanyCamStore(db: PrismaClient): CompanyCamStore {
  const getJob = async (jobId: string): Promise<CcJob | null> => {
    if (!UUID.test(jobId)) return null;
    const r = await db.job.findUnique({ where: { id: jobId }, include });
    return r ? toJob(r as Row) : null;
  };

  return {
    getJob,

    async claim(jobId, now, leaseSeconds, opts) {
      if (!UUID.test(jobId)) return null;
      const leaseEnd = new Date(now.getTime() + leaseSeconds * 1000);
      // One atomic UPDATE: of two callers at once, only one matches the WHERE and gets the job.
      const n = await db.$executeRaw`
        UPDATE jobs SET companycam_status = 'pending', companycam_next_attempt_at = ${leaseEnd}::timestamptz
        WHERE id = ${jobId}::uuid
          AND companycam_status <> 'linked'
          AND NOT (companycam_status = 'pending' AND companycam_next_attempt_at > ${now}::timestamptz)
          AND (${opts.force}::boolean OR (companycam_attempts < ${opts.maxAttempts}::int
               AND NOT (companycam_status = 'error' AND companycam_next_attempt_at > ${now}::timestamptz)))`;
      if (n === 0) return null;
      const job = await getJob(jobId);
      return job ? { ...job, status: "pending" } : null;
    },

    async setLinked(jobId, l) {
      try {
        await db.job.update({
          where: { id: jobId },
          data: {
            companycamStatus: "linked", companycamProjectId: l.projectId, companycamProjectUrl: l.projectUrl, companycamLinkMethod: l.method,
            companycamAttempts: 0, companycamNextAttemptAt: null, companycamError: null,
          },
        });
        return true;
      } catch (e) {
        if (isUniqueViolation(e)) return false;   // that CompanyCam project already belongs to another job
        throw e;
      }
    },

    async setError(jobId, e) {
      await db.job.update({
        where: { id: jobId },
        data: { companycamStatus: "error", companycamError: e.error, companycamAttempts: e.attempts, companycamNextAttemptAt: e.nextAttemptAt },
      });
    },

    async setUnlinked(jobId) {
      await db.job.update({
        where: { id: jobId },
        data: {
          companycamStatus: "none", companycamProjectId: null, companycamProjectUrl: null, companycamLinkMethod: null,
          companycamAttempts: 0, companycamNextAttemptAt: null, companycamError: null,
        },
      });
    },

    async projectOwner(projectId) {
      const r = await db.job.findUnique({ where: { companycamProjectId: projectId }, select: { id: true } });
      return r?.id ?? null;
    },

    async listNeedingSync(limit, now, maxAttempts) {
      const rows = await db.job.findMany({
        where: {
          companycamStatus: { not: "linked" }, needsReview: false,
          stage: { notIn: ["lost", "cancelled_after_approval"] }, companycamAttempts: { lt: maxAttempts },
          OR: [{ companycamNextAttemptAt: null }, { companycamNextAttemptAt: { lte: now } }],
        },
        orderBy: { jobNumber: "asc" }, take: limit, include,
      });
      return rows.map((r) => toJob(r as Row));
    },
  };
}
