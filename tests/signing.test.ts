import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import {
  ContractError, decodeSignaturePng, finalizeSignature, prepareContract, selectPackage,
  sha256Hex, stageAfterSigning, type SignInput,
} from "../src/lib/contracts/sign.ts";
import { MemoryContractStore } from "../src/lib/contracts/memory-store.ts";
import type { ContractJob } from "../src/lib/contracts/types.ts";
import type { StoredScope } from "../src/lib/scopes/types.ts";

// A real, valid noisy PNG so it is large enough to pass the "not blank" check.
function makePng(w = 120, h = 40): Uint8Array {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let i = 1; i <= w * 4; i++) raw[y * (w * 4 + 1) + i] = (Math.random() * 256) | 0;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}
const dataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

const scope: StoredScope & { jobId: string } = {
  id: "s1", jobId: "j1", selected: false, division: "siding", tier: "good", title: "Good - Vinyl", targetMarginBps: 4000,
  costCents: 366_528, saleCents: 610_880, marginBps: 4000,
  items: [{ kind: "material", sortOrder: 0, productId: "p1", description: "Vinyl siding", quantity: 24, unitCostCents: 8_272, unitPriceCents: 13_787, color: "Clay" }],
};
const baseJob = (over: Partial<ContractJob> = {}): ContractJob => ({
  id: "j1", jobNumber: 2, stage: "inspected", estimatorId: "est1", estimatorName: "Estimator One",
  divisions: ["siding"], productionManagerId: null, contractCents: null, depositRequiredCents: 0,
  customerName: "Dana Miller", customerEmail: "dana@example.com", propertyAddress: "100 Example Rd", ...over,
});
function setup(job: Partial<ContractJob> = {}) {
  const store = new MemoryContractStore();
  store.jobs.push(baseJob(job));
  store.scopes.push({ ...scope });
  return store;
}
async function ready(job: Partial<ContractJob> = {}) {
  const store = setup(job);
  await selectPackage(store, "j1", "siding", "good", "est1", scope);
  const doc = await prepareContract(store, "j1");
  return { store, doc };
}
const input = (documentId: string, over: Partial<SignInput> = {}): SignInput => ({
  documentId, userId: "est1", consent: true, signerName: "Dana Miller", signerEmail: "dana@example.com",
  signaturePngDataUrl: dataUrl(makePng()), ip: "203.0.113.9", userAgent: "TestBrowser/1.0", ...over,
});
const code = (p: Promise<unknown>) => p.then(() => "no error", (e: ContractError) => e.code);

test("select: copies price and deposit to the job, moves stage up, logs history", async () => {
  const store = setup();
  const sel = await selectPackage(store, "j1", "siding", "good", "est1", scope);
  assert.equal(sel.depositRequiredCents, 305_440);
  assert.equal(store.jobs[0].contractCents, 610_880);
  assert.equal(store.jobs[0].stage, "scope_presented");
  assert.deepEqual(store.history.map((h) => [h.from, h.to]), [["inspected", "scope_presented"]]);
});

test("select: refused once a contract is signed", async () => {
  const { store, doc } = await ready();
  await finalizeSignature(store, input(doc.id));
  assert.equal(await code(selectPackage(store, "j1", "siding", "good", "est1", scope)), "already_signed");
});

test("prepare: needs a selection and a customer name", async () => {
  const noSel = setup();
  assert.equal(await code(prepareContract(noSel, "j1")), "no_selection");
  const store = setup({ customerName: "  " });
  await selectPackage(store, "j1", "siding", "good", "est1", scope);
  assert.equal(await code(prepareContract(store, "j1")), "missing_customer");
  assert.equal(await code(prepareContract(store, "nope")), "not_found");
});

test("prepare: re-preparing cancels the earlier draft; one live contract", async () => {
  const { store, doc } = await ready();
  const second = await prepareContract(store, "j1");
  assert.notEqual(second.id, doc.id);
  assert.equal((await store.getDocument(doc.id))?.status, "cancelled");
  assert.equal(store.docs.filter((d) => d.status === "draft").length, 1);
  assert.equal(second.unsignedSha256, sha256Hex(second.unsignedData!));
});

test("sign: happy path locks the document, stores evidence, advances the job", async () => {
  const { store, doc } = await ready();
  const r = await finalizeSignature(store, input(doc.id));
  const saved = await store.getDocument(doc.id);
  assert.equal(saved?.status, "signed");
  assert.equal(saved?.signedSha256, sha256Hex(r.signedData));
  assert.equal(sha256Hex(saved!.signedData!), saved?.signedSha256);
  assert.equal(store.jobs[0].stage, "contract_signed");
  assert.deepEqual(store.history.map((h) => h.to), ["scope_presented", "contract_signed"]);
  const sig = store.signatures[0];
  assert.equal(sig.signerName, "Dana Miller");
  assert.equal(sig.ip, "203.0.113.9");
  assert.equal(sig.signedByUserId, "est1");
  assert.equal(sig.signatureSha256, sha256Hex(sig.signaturePng));
  // Signed PDF is the original pages plus a certificate page, with the original hash recorded.
  const unsignedPages = (await PDFDocument.load(doc.unsignedData!)).getPageCount();
  assert.equal((await PDFDocument.load(r.signedData)).getPageCount(), unsignedPages + 1);
  assert.notEqual(r.signedSha256, doc.unsignedSha256);
});

test("sign: a second signature attempt is refused and changes nothing", async () => {
  const { store, doc } = await ready();
  await finalizeSignature(store, input(doc.id));
  const before = (await store.getDocument(doc.id))!.signedSha256;
  assert.equal(await code(finalizeSignature(store, input(doc.id))), "already_signed");
  assert.equal(store.signatures.length, 1);
  assert.equal((await store.getDocument(doc.id))!.signedSha256, before);
});

test("sign: consent, name and email are required", async () => {
  const { store, doc } = await ready();
  assert.equal(await code(finalizeSignature(store, input(doc.id, { consent: false }))), "consent_required");
  assert.equal(await code(finalizeSignature(store, input(doc.id, { signerName: " " }))), "name_required");
  assert.equal(await code(finalizeSignature(store, input(doc.id, { signerEmail: "not-an-email" }))), "email_invalid");
  assert.equal((await store.getDocument(doc.id))?.status, "draft");
});

test("sign: bad signature images are rejected", async () => {
  const { store, doc } = await ready();
  const png = makePng();
  for (const url of [
    "", "data:image/jpeg;base64,AAAA", "data:image/png;base64,AAAA",
    dataUrl(new Uint8Array(2000)),                       // right size, not a PNG
    dataUrl(makePng(8, 4)),                              // too small to be a signature
    dataUrl(new Uint8Array([...png, ...new Uint8Array(500_000)])), // oversized
  ]) {
    assert.equal(await code(finalizeSignature(store, input(doc.id, { signaturePngDataUrl: url }))), "signature_invalid");
  }
  assert.equal((await store.getDocument(doc.id))?.status, "draft");
});

test("sign: a tampered unsigned PDF is refused", async () => {
  const { store, doc } = await ready();
  doc.unsignedData![100] ^= 0xff;
  assert.equal(await code(finalizeSignature(store, input(doc.id))), "tampered");
  assert.equal(store.signatures.length, 0);
});

test("sign: cancelled draft, unknown document and closed job are refused", async () => {
  const { store, doc } = await ready();
  assert.equal(await code(finalizeSignature(store, input("nope"))), "not_found");
  store.jobs[0].stage = "lost";
  assert.equal(await code(finalizeSignature(store, input(doc.id))), "job_closed");
  store.jobs[0].stage = "scope_presented";
  const newer = await prepareContract(store, "j1");
  assert.equal(await code(finalizeSignature(store, input(doc.id))), "not_draft"); // old draft was cancelled
  assert.equal((await store.getDocument(newer.id))?.status, "draft");
});

test("edit after select: clearing the selection cancels the draft contract", async () => {
  const { store, doc } = await ready();
  await store.clearSelectionIfSelected("j1", "siding", "good");
  assert.equal((await store.getDocument(doc.id))?.status, "cancelled");
  assert.equal(store.jobs[0].contractCents, null);
  assert.equal(await code(prepareContract(store, "j1")), "no_selection");
});

test("stage after signing never moves backward and ignores closed jobs", () => {
  assert.equal(stageAfterSigning("inspected"), "contract_signed");
  assert.equal(stageAfterSigning("scope_presented"), "contract_signed");
  assert.equal(stageAfterSigning("contract_signed"), "contract_signed");
  assert.equal(stageAfterSigning("in_production"), "in_production");
  assert.equal(stageAfterSigning("lost"), null);
});

test("signature png decoder accepts a real PNG", () => {
  assert.ok(decodeSignaturePng(dataUrl(makePng())).length > 1200);
});
