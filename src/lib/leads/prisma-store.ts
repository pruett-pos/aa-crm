import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { Division, Stage } from "../rules.ts";
import type { Market } from "./routing.ts";
import type {
  CustomerHit, CustomerRow, LeadListItem, LeadSource, LeadStore, LeadTx, PropertyRow,
} from "./types.ts";

const UUID = /^[0-9a-f-]{36}$/i;
const monthDate = (m: string) => new Date(`${m}-01T00:00:00Z`);
const monthText = (d: Date) => d.toISOString().slice(0, 7);

const toCustomer = (c: { id: string; firstName: string; lastName: string; phone: string | null; email: string | null; lastEstimatorId: string | null }): CustomerRow => ({
  id: c.id, firstName: c.firstName, lastName: c.lastName, phone: c.phone, email: c.email, lastEstimatorId: c.lastEstimatorId,
});
const toProperty = (p: { id: string; customerId: string; street: string; city: string; state: string; zip: string; market: string }): PropertyRow => ({
  id: p.id, customerId: p.customerId, street: p.street, city: p.city, state: p.state, zip: p.zip, market: p.market as Market,
});

export function createPrismaLeadStore(db: PrismaClient): LeadStore {
  async function listJobs(where: { needsReview?: boolean }, take: number): Promise<LeadListItem[]> {
    const jobs = await db.job.findMany({
      where, orderBy: { jobNumber: "desc" }, take,
      include: { property: { include: { customer: true } } },
    });
    const ids = [...new Set(jobs.flatMap((j) => [j.estimatorId, j.productionManagerId]).filter((x): x is string => !!x))];
    const users = ids.length ? await db.user.findMany({ where: { id: { in: ids } } }) : [];
    const name = (id: string | null) => users.find((u) => u.id === id)?.fullName ?? null;
    return jobs.map((j) => ({
      jobId: j.id, jobNumber: j.jobNumber, customerName: `${j.property.customer.firstName} ${j.property.customer.lastName}`,
      phone: j.property.customer.phone, street: j.property.street, city: j.property.city,
      market: j.property.market as Market, jobType: j.jobType, divisions: j.divisions as Division[],
      source: j.source as LeadSource, stage: j.stage, estimatorName: name(j.estimatorId), pmName: name(j.productionManagerId),
      needsReview: j.needsReview, needsAssignment: !j.estimatorId && !j.productionManagerId, createdAt: j.createdAt,
    }));
  }

  return {
    async searchCustomers({ phoneDigits, text }): Promise<CustomerHit[]> {
      const tokens = (text ?? "").split(" ").filter(Boolean).slice(0, 4);
      const where = phoneDigits
        ? { phoneDigits: { endsWith: phoneDigits } }
        : {
            AND: tokens.map((t) => ({
              OR: [
                { firstName: { contains: t, mode: "insensitive" as const } },
                { lastName: { contains: t, mode: "insensitive" as const } },
                { properties: { some: { street: { contains: t, mode: "insensitive" as const } } } },
              ],
            })),
          };
      const rows = await db.customer.findMany({
        where, take: 15, orderBy: { createdAt: "desc" },
        include: { properties: { include: { jobs: { select: { id: true, jobNumber: true, stage: true }, orderBy: { jobNumber: "desc" }, take: 5 } } } },
      });
      return rows.map((c) => ({
        ...toCustomer(c),
        properties: c.properties.map((p) => ({
          id: p.id, street: p.street, city: p.city, state: p.state, zip: p.zip, market: p.market as Market,
          jobs: p.jobs.map((j) => ({ id: j.id, jobNumber: j.jobNumber, stage: j.stage })),
        })),
      }));
    },

    async getPmRows() {
      const rows = await db.divisionManager.findMany();
      return rows.map((r) => ({ division: r.division as Division, market: r.market as Market, userId: r.userId }));
    },
    async isActiveEstimator(userId) {
      if (!UUID.test(userId)) return false;
      return (await db.user.count({ where: { id: userId, role: "estimator", active: true } })) > 0;
    },
    async listEstimators() {
      const rows = await db.user.findMany({ where: { role: "estimator", active: true }, orderBy: { fullName: "asc" } });
      return rows.map((u) => ({ id: u.id, fullName: u.fullName }));
    },
    listReviewQueue: () => listJobs({ needsReview: true }, 100),
    listLeads: (limit) => listJobs({}, limit),

    async upsertSpend(source, month, spendCents) {
      await db.marketingSpend.upsert({
        where: { source_month: { source, month: monthDate(month) } },
        create: { source, month: monthDate(month), spendCents: BigInt(spendCents) },
        update: { spendCents: BigInt(spendCents) },
      });
    },
    async listSpend(fromMonth, toMonth) {
      const rows = await db.marketingSpend.findMany({ where: { month: { gte: monthDate(fromMonth), lte: monthDate(toMonth) } } });
      return rows.map((r) => ({ source: r.source as LeadSource, month: monthText(r.month), spendCents: Number(r.spendCents) }));
    },

    async transaction(fn) {
      return db.$transaction(async (tx) => {
        const handle: LeadTx = {
          async findCustomerByPhone(digits) {
            const c = await tx.customer.findFirst({ where: { phoneDigits: digits }, orderBy: { createdAt: "asc" } });
            return c ? toCustomer(c) : null;
          },
          async getCustomer(id) {
            if (!UUID.test(id)) return null;
            const c = await tx.customer.findUnique({ where: { id } });
            return c ? toCustomer(c) : null;
          },
          async createCustomer(c) {
            return toCustomer(await tx.customer.create({
              data: { firstName: c.firstName, lastName: c.lastName, phone: c.phone, phoneDigits: c.phoneDigits, email: c.email },
            }));
          },
          async getProperty(id) {
            if (!UUID.test(id)) return null;
            const p = await tx.property.findUnique({ where: { id } });
            return p ? toProperty(p) : null;
          },
          async findPropertyByAddress(customerId, street, zip) {
            const p = await tx.property.findFirst({ where: { customerId, zip, street: { equals: street, mode: "insensitive" } } });
            return p ? toProperty(p) : null;
          },
          async createProperty(p) {
            return toProperty(await tx.property.create({ data: { customerId: p.customerId, street: p.street, city: p.city, state: p.state, zip: p.zip, market: p.market } }));
          },
          async createJob(j) {
            const row = await tx.job.create({
              data: {
                propertyId: j.propertyId, jobType: j.jobType, divisions: j.divisions, stage: j.stage, source: j.source,
                needsReview: j.needsReview, appointmentAt: j.appointmentAt, estimatorId: j.estimatorId,
                productionManagerId: j.productionManagerId, createdBy: j.createdBy,
              },
            });
            return { id: row.id, jobNumber: row.jobNumber };
          },
          async addHistory(jobId, from, to, by) {
            await tx.jobStageHistory.create({ data: { jobId, fromStage: (from as Stage | null) ?? null, toStage: to, changedBy: by } });
          },
          async setLastEstimator(customerId, userId) {
            await tx.customer.update({ where: { id: customerId }, data: { lastEstimatorId: userId } });
          },
          async getReviewJob(jobId) {
            if (!UUID.test(jobId)) return null;
            const j = await tx.job.findUnique({ where: { id: jobId }, include: { property: { include: { customer: true } } } });
            if (!j) return null;
            return {
              id: j.id, jobNumber: j.jobNumber, needsReview: j.needsReview, propertyId: j.propertyId,
              customerId: j.property.customerId, lastEstimatorId: j.property.customer.lastEstimatorId, stage: j.stage,
            };
          },
          async updateReviewedJob(jobId, u) {
            await tx.job.update({
              where: { id: jobId },
              data: { jobType: u.jobType, divisions: u.divisions, estimatorId: u.estimatorId, productionManagerId: u.productionManagerId, needsReview: false },
            });
          },
          async updatePropertyMarket(propertyId, market) {
            await tx.property.update({ where: { id: propertyId }, data: { market } });
          },
          async logEvent(system, payload) {
            await tx.integrationEvent.create({ data: { system, direction: "in", status: "ok", payload: payload as object } });
          },
        };
        return fn(handle);
      });
    },
  };
}
