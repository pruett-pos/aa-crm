import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { SelectionError, combineSelections, stageAfterSelection, validateSelectable } from "../src/lib/contracts/select.ts";
import {
  contractText, renderContractPdf, pdfSafe, spotsFromKeywords, type ContractData, type ContractSection,
} from "../src/lib/contracts/pdf.ts";

const siding: ContractSection = {
  divisionLabel: "Siding", packageTitle: "Good - Vinyl", subtotalCents: 614_400,
  items: [
    { description: "Vinyl siding", quantity: 24, unitPriceCents: 13_933, color: "Clay" },
    { description: "Install", quantity: 24, unitPriceCents: 11_667, color: null },
  ],
};
const roofing: ContractSection = {
  divisionLabel: "Roofing", packageTitle: "Better - Highlander", subtotalCents: 500_000,
  items: [{ description: "Architectural shingles", quantity: 20, unitPriceCents: 25_000, color: "Weathered Wood" }],
};
const contract = (over: Partial<ContractData> = {}): ContractData => ({
  jobNumber: 2, customerName: "Dana Miller", propertyAddress: "100 Example Rd, West Plains, MO 65775",
  issuedOn: new Date("2026-10-05T12:00:00Z"), sections: [siding], totalCents: 614_400, depositCents: 307_200, ...over,
});

// A chosen package for one trade, as combineSelections sees it.
const chosen = (division: string, saleCents: number, productId: string | null = "p1") => ({
  division, saleCents, costCents: Math.round(saleCents * 0.6), items: [{ kind: "material", productId }],
});

test("combine: deposit due over $5,000, none at exactly $5,000", () => {
  assert.equal(combineSelections([chosen("siding", 500_100)], new Set()).depositRequiredCents, 250_050);
  assert.equal(combineSelections([chosen("siding", 500_000)], new Set()).depositRequiredCents, 0);
});

test("combine: a special-order material forces the 50% deposit under $5,000", () => {
  const s = combineSelections([chosen("siding", 300_000, "special")], new Set(["special"]));
  assert.equal(s.hasSpecialOrder, true);
  assert.equal(s.depositRequiredCents, 150_000);
  assert.equal(combineSelections([chosen("siding", 300_000, "p1")], new Set(["special"])).hasSpecialOrder, false);
});

test("combine: one trade copies its sale price and cost for the contract", () => {
  const s = combineSelections([chosen("siding", 1_000_000)], new Set());
  assert.deepEqual([s.contractCents, s.costCents, s.selectedDivisions], [1_000_000, 600_000, ["siding"]]);
});

test("combine: the contract is the SUM of every trade's chosen package", () => {
  const s = combineSelections([chosen("roofing", 700_000), chosen("siding", 300_000)], new Set());
  assert.deepEqual([s.contractCents, s.costCents, s.selectedDivisions], [1_000_000, 600_000, ["roofing", "siding"]]);
});

test("combine: two trades under $5,000 each need a deposit once they total over $5,000", () => {
  const roofingAlone = combineSelections([chosen("roofing", 300_000)], new Set());
  const sidingAlone = combineSelections([chosen("siding", 300_000)], new Set());
  assert.equal(roofingAlone.depositRequiredCents, 0);
  assert.equal(sidingAlone.depositRequiredCents, 0);
  const both = combineSelections([chosen("roofing", 300_000), chosen("siding", 300_000)], new Set());
  assert.deepEqual([both.contractCents, both.depositRequiredCents], [600_000, 300_000]);
});

test("combine: a special-order material in ANY trade forces the deposit on the whole job", () => {
  const s = combineSelections([chosen("roofing", 100_000, "special"), chosen("siding", 100_000, "p1")], new Set(["special"]));
  assert.deepEqual([s.hasSpecialOrder, s.contractCents, s.depositRequiredCents], [true, 200_000, 100_000]);
});

test("combine: nothing chosen is all zeros", () => {
  assert.deepEqual(combineSelections([], new Set()), {
    contractCents: 0, costCents: 0, hasSpecialOrder: false, depositRequiredCents: 0, selectedDivisions: [],
  });
});

test("stage after selecting: moves up to scope_presented, never backward; closed jobs stay closed", () => {
  assert.equal(stageAfterSelection("new_lead"), "scope_presented");
  assert.equal(stageAfterSelection("claim_approved"), "scope_presented");
  assert.equal(stageAfterSelection("scope_presented"), "scope_presented");
  assert.equal(stageAfterSelection("contract_signed"), "contract_signed");
  assert.equal(stageAfterSelection("in_production"), "in_production");
  assert.equal(stageAfterSelection("lost"), "lost");
});

test("selectable: rejects empty or unpriced packages and closed jobs", () => {
  assert.throws(() => validateSelectable({ saleCents: 0, costCents: 0, items: [] }, "inspected"), SelectionError);
  assert.throws(() => validateSelectable({ saleCents: 100_000, costCents: 60_000, items: [] }, "inspected"), SelectionError);
  assert.throws(() => validateSelectable(chosen("siding", 100_000), "lost"), SelectionError);
  assert.throws(() => validateSelectable(chosen("siding", 100_000), "cancelled_after_approval"), SelectionError);
  assert.doesNotThrow(() => validateSelectable(chosen("siding", 100_000), "inspected"));
});

test("contract text, one trade: prices, total and deposit; no subtotal line; no cost, margin or commission", () => {
  const { lines } = contractText(contract());
  const text = lines.join("\n");
  assert.ok(text.includes("Siding: Good - Vinyl"));
  assert.ok(text.includes("Total price: $6,144.00"));
  assert.ok(text.includes("Deposit due before materials are ordered: $3,072.00"));
  assert.ok(text.includes("Vinyl siding (Clay) - 24 x $139.33 = $3,343.92"));
  assert.ok(!text.includes("subtotal"));
  assert.ok(text.includes("DRAFT TERMS"));
  assert.ok(!/cost|margin|commission|markup/i.test(text.replace(/DRAFT[\s\S]*$/, "")));
});

test("contract text, several trades: a section and subtotal per trade, then one grand total", () => {
  const d = contract({ sections: [roofing, siding], totalCents: 1_114_400, depositCents: 557_200 });
  const { lines, boldLines } = contractText(d);
  const text = lines.join("\n");
  assert.ok(text.includes("Roofing: Better - Highlander"));
  assert.ok(text.includes("Siding: Good - Vinyl"));
  assert.ok(text.includes("Roofing subtotal: $5,000.00"));
  assert.ok(text.includes("Siding subtotal: $6,144.00"));
  assert.ok(text.includes("Total price: $11,144.00"));
  assert.ok(text.indexOf("Roofing: Better") < text.indexOf("Siding: Good"));            // trades appear in the job's order
  assert.ok(text.indexOf("Siding subtotal") < text.indexOf("Total price"));
  assert.ok(!/cost|margin|commission|markup/i.test(text.replace(/DRAFT[\s\S]*$/, "")));
  // headings, subtotals and the grand total are drawn bold
  for (const needle of ["Roofing: Better", "Siding subtotal", "Total price"]) {
    assert.ok(boldLines.has(lines.findIndex((l) => l.startsWith(needle))), needle);
  }
});

test("contract text: no-deposit wording", () => {
  const text = contractText(contract({ depositCents: 0 })).lines.join("\n");
  assert.ok(text.includes("No deposit is required"));
  assert.ok(!text.includes("Deposit due"));
});

test("contract pdf: valid PDF that records where to sign; multi-trade contracts render", async () => {
  const bytes = await renderContractPdf(contract());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  const spots = spotsFromKeywords(pdf.getKeywords());
  assert.ok(spots && spots.sig.page === 0 && spots.sig.y > spots.date.y);
  const multi = await PDFDocument.load(await renderContractPdf(contract({ sections: [roofing, siding], totalCents: 1_114_400 })));
  assert.ok(multi.getPageCount() >= 1);
});

test("contract pdf: long scopes paginate", async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({
    description: `Line item ${i} with a fairly long description that should wrap across the page width without breaking`,
    quantity: 1, unitPriceCents: 1_000, color: null,
  }));
  const long = await PDFDocument.load(await renderContractPdf(contract({ sections: [{ ...siding, items: many }] })));
  assert.ok(long.getPageCount() > 1);
});

test("contract pdf: non-Latin text does not crash rendering", async () => {
  const curlyAndCyrillic = JSON.parse('"Dana “D” — Привет"');
  assert.equal(pdfSafe(curlyAndCyrillic), 'Dana "D" - ??????');
  const bytes = await renderContractPdf(contract({ customerName: JSON.parse('"При ‘Test’"') }));
  assert.ok(bytes.length > 500);
});
