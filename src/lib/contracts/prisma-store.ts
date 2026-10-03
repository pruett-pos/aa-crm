import type { PrismaClient } from "../../generated/prisma/client.ts";
import { toStored } from "../scopes/prisma-store.ts";
import type { Stage } from "../rules.ts";
import type { Tier } from "../scopes/types.ts";
import type { Selection } from "./select.ts";
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

    async getSelectedScope(jobId) {
      const s = await db.scope.findFirst({ where: { jobId, selected: true }, include: { items: true } });
      return s ? toStored(s) : null;
    },

    async specialOrderProductIds() {
      const rows = await db.product.findMany({ where: { specialOrder: true }, select: { id: true } });
      return new Set(rows.map((r) => r.id));
    },

    async applySelection(jobId: string, tier: Tier, sel: Selection, userId: string) {
      await db.$transaction(async (tx) => {
        const job = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
        await tx.scope.updateMany({ where: { jobId }, data: { selected: false } });
        const res = await tx.scope.updateMany({ where: { jobId, tier }, data: { selected: true } });
        if (res.count !== 1) throw new Error("Package has not been saved yet");
        await tx.job.update({
          where: { id: jobId },
          data: {
            contractCents: BigInt(sel.contractCents), costCents: BigInt(sel.costCents),
            hasSpecialOrder: sel.hasSpecialOrder, depositRequiredCents: BigInt(sel.depositRequiredCents),
            stage: sel.stage as Stage,
          },
        });
        if (job.stage !== sel.stage) {
          await tx.jobStageHistory.create({ data: { jobId, fromStage: job.stage, toStage: sel.stage, changedBy: userId } });
        }
        await tx.document.updateMany({ where: { jobId, kind: "contract", status: "draft" }, data: { status: "cancelled" } });
      });
    },

    async clearSelectionIfSelected(jobId, tier) {
      await db.$transaction(async (tx) => {
        const res = await tx.scope.updateMany({ where: { jobId, tier, selected: true }, data: { selected: false } });
        if (res.count === 0) return;
        await tx.job.update({
          where: { id: jobId },
          data: { contractCents: null, costCents: null, hasSpecialOrder: false, depositRequiredCents: BigInt(0) },
        });
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
