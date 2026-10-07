import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCatalogStore } from "../src/lib/catalog/memory-store.ts";
import { CatalogError, MAX_RETAIL_CENTS, addProduct, changeProduct, removeProduct, validateProduct, type ProductInput } from "../src/lib/catalog/service.ts";
import { pruettPriceCents } from "../src/lib/rules.ts";

const input = (over: Partial<ProductInput> = {}): ProductInput => ({ sku: "SHG-HL", name: "Architectural shingles - Highlander", unit: "sq", priceText: "135.00", specialOrder: false, ...over });
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof CatalogError ? e.code : "other"; } };

test("a good product is cleaned up and the price becomes whole cents", () => {
  assert.deepEqual(validateProduct(input({ sku: " SHG-HL ", name: "  Ridge   cap  ", unit: " Bundle ", priceText: "$1,234.5", specialOrder: true })),
    { sku: "SHG-HL", name: "Ridge cap", unit: "bundle", retailCents: 123_450, specialOrder: true });
});

test("price: a clean amount only, above zero, never a float", () => {
  for (const bad of ["", "0", "0.00", "-5", "abc", "12.345", "1e3", " "]) assert.throws(() => validateProduct(input({ priceText: bad })), /price/i, bad);
  assert.equal(validateProduct(input({ priceText: "0.07" })).retailCents, 7);
  assert.equal(validateProduct(input({ priceText: "19.99" })).retailCents, 1999);   // a float would give 1998.9999...
});

test("price: one unit over the ceiling is refused", () => {
  assert.equal(validateProduct(input({ priceText: String(MAX_RETAIL_CENTS / 100) })).retailCents, MAX_RETAIL_CENTS);
  assert.throws(() => validateProduct(input({ priceText: String(MAX_RETAIL_CENTS / 100 + 1) })), /too high/);
});

test("sku, name and unit are checked", () => {
  for (const sku of ["", " ", "has space", "-lead", "a".repeat(41), "bad;drop", "émile"]) assert.throws(() => validateProduct(input({ sku })), /SKU/, sku);
  for (const sku of ["A", "SHG-HL", "ab.cd/12_x"]) assert.equal(validateProduct(input({ sku })).sku, sku);
  for (const name of ["", " ", "x", "n".repeat(121)]) assert.throws(() => validateProduct(input({ name })), /name/, name);
  for (const unit of ["", "12", "square feet", "sq.", "toolongunit"]) assert.throws(() => validateProduct(input({ unit })), /unit/, unit);
});

test("only a plain true makes a product special order", () => {
  assert.equal(validateProduct(input({ specialOrder: true })).specialOrder, true);
  assert.equal(validateProduct({ ...input(), specialOrder: "yes" as unknown as boolean }).specialOrder, false);
});

test("add, list in name order, and a duplicate SKU is refused whatever its case", async () => {
  const s = new MemoryCatalogStore();
  await addProduct(s, input({ sku: "B", name: "Underlayment" }));
  await addProduct(s, input({ sku: "A", name: "Architectural shingles" }));
  assert.deepEqual((await s.list()).map((p) => p.name), ["Architectural shingles", "Underlayment"]);
  assert.equal(await code(addProduct(s, input({ sku: "a", name: "Another" }))), "duplicate_sku");
  assert.equal((await s.list()).length, 2);
});

test("edit keeps the id, can keep its own SKU, and cannot take another product's SKU", async () => {
  const s = new MemoryCatalogStore();
  const a = await addProduct(s, input({ sku: "A", name: "Alpha" }));
  await addProduct(s, input({ sku: "B", name: "Beta" }));
  const edited = await changeProduct(s, a.id, input({ sku: "A", name: "Alpha 2", priceText: "10.00" }));
  assert.deepEqual([edited.id, edited.name, edited.retailCents], [a.id, "Alpha 2", 1000]);
  assert.equal(await code(changeProduct(s, a.id, input({ sku: "b" }))), "duplicate_sku");
  assert.equal(await code(changeProduct(s, "nope", input())), "not_found");
});

test("a product a scope or assembly uses cannot be removed; an unused one can", async () => {
  const s = new MemoryCatalogStore();
  const used = await addProduct(s, input({ sku: "U", name: "Used" }));
  const free = await addProduct(s, input({ sku: "F", name: "Free" }));
  s.usedIds.add(used.id);
  assert.equal(await code(removeProduct(s, used.id)), "in_use");
  assert.equal(await code(removeProduct(s, free.id)), "ok");
  assert.equal(await code(removeProduct(s, free.id)), "not_found");
  assert.deepEqual((await s.list()).map((p) => p.id), [used.id]);
});

test("what A&A pays comes from the shared Builder rule (retail minus 12%)", () => {
  assert.equal(pruettPriceCents(validateProduct(input({ priceText: "135.00" })).retailCents), 11_880);
});
