import type { PrismaClient } from "../../generated/prisma/client.ts";
import { toStored } from "../scopes/prisma-store.ts";
import type { Division, Stage } from "../rules.ts";
import type { Tier } from "../scopes/types.ts";
import { combineSelections, stageAfterSelection, type Combined } from "./select.ts";
import type { ContractJob, ContractStore, DocumentRecord, JobStageOrClosed } from "./types.ts";

type DbDoc = {
  id: string; jobId: string; status: string; signerEmail: string | null;
  unsignedData: Uint8Array | null; unsignedSha256: string | null;
  fileData: Uint8Array | null; signedSha256: string | null; signedAt: Date | null;
};

function toRecord(d: DbDoc): DocumentRecord {
  const signed = d.status === "signed";
  return {
    id: d.id, jobId: d.jobId, status: d.status as DocumentRecord["status"], signerEmail: d.signerEmail,
    unsignedData: d.unsignedData, unsignedSha256: d.unsignedSha256,
    signedData: signed ? d.fileData : null, signedSha256: d.signedSha256, signedAt: d.signedAt,
  };
}

// Prisma wants plain ArrayBuffer-backed bytes.
const bytes = (u: Uint8Array) => Buffer.from(u) as unknown as Uint8Array<ArrayBuffer>;

type Tx = Pick<PrismaClient, "job" | "scope" | "product">;

async function specialIds(c: Pick<PrismaClient, "product">): Promise<Set<string>> {
  const rows = await c.product.findMany({ where: { specialOrder: true }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/**
 * Recompute the job's contract, cost, special-order flag and deposit from every trade's chosen package
 * (the one place the combination happens; the rule itself lives in select.ts and rules.ts).
 * With nothing chosen the job's contract figures are cleared.
 */
async function recompute(tx: Tx, jobId: string): Promise<Combined | null> {
  const chosen = await tx.scope.findMany({ where: { jobId, selected: true }, include: { items: true } });
  if (chosen.length === 0) {
    await tx.job.update({
      where: { id: jobId },
      data: { contractCents: null, costCents: null, hasSpecialOrder: false, depositRequiredCents: BigInt(0) },
    });
    return null;
  }
  const combined = combineSelections(chosen.map(toStored), await specialIds(tx));
  await tx.job.update({
    where: { id: jobId },
    data: {
      contractCents: BigInt(combined.contractCents), costCents: BigInt(combined.costCents),
      hasSpecialOrder: combined.hasSpecialOrder, depositRequiredCents: BigInt(combined.depositRequiredCents),
    },
  });
  return combined;
}
export function createPrismaContractStore(db: PrismaClient): ContractStore {
  return {
    async getContractJob(jobId) {
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
      const j = await db.job.findUnique({ where: { id: jobId }, include: { property: { include: { customer: true } } } });
      if (!j) return null;
      const est = j.estimatorId ? await db.user.findUnique({ where: { id: j.estimatorId } }) : null;
      const c = j.property.customer;
      const job: ContractJob = {
        id: j.id, jobNumber: j.jobNumber, stage: j.stage as JobStageOrClosed,
        estimatorId: j.estimatorId, estimatorName: est?.fullName ?? null,
        divisions: j.divisions, productionManagerId: j.productionManagerId,
        contractCents: j.contractCents === null ? null : Number(j.contractCents),
        depositRequiredCents: Number(j.depositRequiredCents),
        customerName: `${c.firstName} ${c.lastName}`.trim(), customerEmail: c.email,
        propertyAddress: `${j.property.street}, ${j.property.city}, ${j.property.state} ${j.property.zip}`,
      };
      return job;
    },

    async getSelectedScopes(jobId) {
      const rows = await db.scope.findMany({ where: { jobId, selected: true }, include: { items: true } });
      return rows.map(toStored);
    },

    async specialOrderProductIds() {
      return specialIds(db);
    },

    async applySelection(jobId: string, division: Division, tier: Tier, userId: string): Promise<Combined> {
      return db.$transaction(async (tx) => {
        const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
        // Only this trade's choice changes; other trades keep theirs.
        await tx.scope.updateMany({ where: { jobId, division }, data: { selected: false } });
        const res = await tx.scope.updateMany({ where: { jobId, division, tier }, data: { selected: true } });
        if (res.count !== 1) throw new Error("Package has not been saved yet");
        const combined = (await recompute(tx, jobId))!;
        const next = stageAfterSelection(job.stage);
        if (next !== job.stage && next !== "lost" && next !== "cancelled_after_approval") {
          await tx.job.update({ where: { id: jobId }, data: { stage: next as Stage } });
          await tx.jobStageHistory.create({ data: { jobId, fromStage: job.stage, toStage: next as Stage, changedBy: userId } });
        }
        await tx.document.updateMany({ where: { jobId, kind: "contract", status: "draft" }, data: { status: "cancelled" } });
        return combined;
      });
    },

    async clearSelectionIfSelected(jobId, division, tier) {
      await db.$transaction(async (tx) => {
        const res = await tx.scope.updateMany({ where: { jobId, division, tier, selected: true }, data: { selected: false } });
        if (res.count === 0) return;
        await recompute(tx, jobId);
        await tx.document.updateMany({ where: { jobId, kind: "contract", status: "draft" }, data: { status: "cancelled" } });
      });
    },

    async addDivision(jobId, division) {
      await db.$transaction(async (tx) => {
        const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
        if (!job.divisions.includes(division)) await tx.job.update({ where: { id: jobId }, data: { divisions: [...job.divisions, division] } });
      });
    },

    async removeDivision(jobId, division) {
      await db.$transaction(async (tx) => {
        const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
        await tx.job.update({ where: { id: jobId }, data: { divisions: job.divisions.filter((d) => d !== division) } });
        await tx.scope.deleteMany({ where: { jobId, division } }); // items go with them (cascade)
        await recompute(tx, jobId);
        await tx.document.updateMany({ where: { jobId, kind: "contract", status: "draft" }, data: { status: "cancelled" } });
      });
    },
    async hasSignedContract(jobId) {
      return (await db.document.count({ where: { jobId, kind: "contract", status: "signed" } })) > 0;
    },

    async getLiveContract(jobId) {
      const d = await db.document.findFirst({
        where: { jobId, kind: "contract", status: { not: "cancelled" } }, orderBy: { createdAt: "desc" },
      });
      return d ? toRecord(d) : null;
    },

    async getDocument(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const d = await db.document.findUnique({ where: { id } });
      return d ? toRecord(d) : null;
    },

    async createContractDocument(jobId, d) {
      const rec = await db.$transaction(async (tx) => {
        if ((await tx.document.count({ where: { jobId, kind: "contract", status: "signed" } })) > 0) {
          throw new Error("A contract is already signed for this job");
        }
        await tx.document.updateMany({ where: { jobId, kind: "contract", status: "draft" }, data: { status: "cancelled" } });
        const created = await tx.document.create({
          data: {
            jobId, kind: "contract", fileUrl: "", status: "draft", signerEmail: d.signerEmail,
            fileData: bytes(d.bytes), unsignedData: bytes(d.bytes), unsignedSha256: d.sha256,
          },
        });
        return tx.document.update({ where: { id: created.id }, data: { fileUrl: `/api/documents/${created.id}/file` } });
      });
      return toRecord(rec);
    },

    async completeSignature(a) {
      return db.$transaction(async (tx) => {
        // Only a still-draft document can be signed, so two submissions can't both win.
        const res = await tx.document.updateMany({
          where: { id: a.documentId, status: "draft" },
          data: {
            status: "signed", fileData: bytes(a.signedData), signedSha256: a.signedSha256,
            signedAt: a.signature.signedAt, signerEmail: a.signature.signerEmail,
          },
        });
        if (res.count !== 1) return false;
        await tx.contractSignature.create({
          data: {
            documentId: a.documentId, signerName: a.signature.signerName, signerEmail: a.signature.signerEmail,
            consentAt: a.signature.consentAt, signedAt: a.signature.signedAt, ip: a.signature.ip,
            userAgent: a.signature.userAgent, signaturePng: bytes(a.signature.signaturePng),
            signatureSha256: a.signature.signatureSha256, signedByUserId: a.signature.signedByUserId,
          },
        });
        if (a.newStage && a.newStage !== a.previousStage) {
          await tx.job.update({ where: { id: a.jobId }, data: { stage: a.newStage } });
          await tx.jobStageHistory.create({
            data: { jobId: a.jobId, fromStage: a.previousStage as Stage, toStage: a.newStage, changedBy: a.signature.signedByUserId },
          });
        }
        return true;
      });
    },
  };
}
