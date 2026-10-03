import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { selectScope, SelectionError } from "../src/lib/contracts/select.ts";
import {
  contractText, renderContractPdf, pdfSafe, spotsFromKeywords, type ContractData,
} from "../src/lib/contracts/pdf.ts";

const contract = (over: Partial<ContractData> = {}): ContractData => ({
  jobNumber: 2, customerName: "Dana Miller", propertyAddress: "100 Example Rd, West Plains, MO 65775",
  packageTitle: "Good - Vinyl", issuedOn: new Date("2026-10-05T12:00:00Z"),
  items: [
    { description: "Vinyl siding", quantity: 24, unitPriceCents: 13_933, color: "Clay" },
    { description: "Install", quantity: 24, unitPriceCents: 11_667, color: null },
  ],
  totalCents: 614_400, depositCents: 307_200, ...over,
});

const scope = (saleCents: number, productId: string | null = "p1") => ({
  saleCents, costCents: Math.round(saleCents * 0.6), items: [{ kind: "material", productId }],
});

test("select: deposit due over $5,000, none at exactly $5,000", () => {
  assert.equal(selectScope(scope(500_100), new Set(), "inspected").depositRequiredCents, 250_050);
  assert.equal(selectScope(scope(500_000), new Set(), "inspected").depositRequiredCents, 0);
});

test("select: a special-order material forces the 50% deposit under $5,000", () => {
  const s = selectScope(scope(300_000, "special"), new Set(["special"]), "inspected");
  assert.equal(s.hasSpecialOrder, true);
  assert.equal(s.depositRequiredCents, 150_000);
  assert.equal(selectScope(scope(300_000, "p1"), new Set(["special"]), "inspected").hasSpecialOrder, false);
});

test("select: copies sale price and cost for the contract", () => {
  const s = selectScope(scope(1_000_000), new Set(), "inspected");
  assert.equal(s.contractCents, 1_000_000);
  assert.equal(s.costCents, 600_000);
});

test("select: stage moves up to scope_presented, never backward", () => {
  assert.equal(selectScope(scope(100_000), new Set(), "new_lead").stage, "scope_presented");
  assert.equal(selectScope(scope(100_000), new Set(), "claim_approved").stage, "scope_presented");
  assert.equal(selectScope(scope(100_000), new Set(), "scope_presented").stage, "scope_presented");
  assert.equal(selectScope(scope(100_000), new Set(), "contract_signed").stage, "contract_signed");
  assert.equal(selectScope(scope(100_000), new Set(), "in_production").stage, "in_production");
});

test("contract text: shows customer prices, total and deposit; no cost, margin or commission", () => {
  const { lines } = contractText(contract());
  const text = lines.join("\n");
  assert.ok(text.includes("Total price: $6,144.00"));
  assert.ok(text.includes("Deposit due before materials are ordered: $3,072.00"));
  assert.ok(text.includes("Vinyl siding (Clay) - 24 x $139.33 = $3,343.92"));
  assert.ok(text.includes("DRAFT TERMS"));
  assert.ok(!/cost|margin|commission|markup/i.test(text.replace(/DRAFT[\s\S]*$/, "")));
});

test("contract text: no-deposit wording", () => {
  const text = contractText(contract({ depositCents: 0 })).lines.join("\n");
  assert.ok(text.includes("No deposit is required"));
  assert.ok(!text.includes("Deposit due"));
});

test("contract pdf: valid PDF that records where to sign, paginates long scopes", async () => {
  const bytes = await renderContractPdf(contract());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  const pdf = await PDFDocument.load(bytes);
  const spots = spotsFromKeywords(pdf.getKeywords());
  assert.ok(spots && spots.sig.page === 0 && spots.sig.y > spots.date.y);

  const many = Array.from({ length: 80 }, (_, i) => ({
    description: `Line item ${i} with a fairly long description that should wrap across the page width without breaking`,
    quantity: 1, unitPriceCents: 1_000, color: null,
  }));
  const long = await PDFDocument.load(await renderContractPdf(contract({ items: many })));
  assert.ok(long.getPageCount() > 1);
});

test("contract pdf: non-Latin text does not crash rendering", async () => {
  const curlyAndCyrillic = JSON.parse('"Dana \u201CD\u201D \u2014 \u041F\u0440\u0438\u0432\u0435\u0442"');
  assert.equal(pdfSafe(curlyAndCyrillic), 'Dana "D" - ??????');
  const bytes = await renderContractPdf(contract({ customerName: JSON.parse('"\u041F\u0440\u0438 \u2018Test\u2019"') }));
  assert.ok(bytes.length > 500);
});

test("select: rejects empty or unpriced packages and closed jobs", () => {
  assert.throws(() => selectScope({ saleCents: 0, costCents: 0, items: [] }, new Set(), "inspected"), SelectionError);
  assert.throws(() => selectScope(scope(100_000), new Set(), "lost"), SelectionError);
  assert.throws(() => selectScope(scope(100_000), new Set(), "cancelled_after_approval"), SelectionError);
});

