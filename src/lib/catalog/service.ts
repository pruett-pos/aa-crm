import { parseDollarsToCents } from "../rules.ts";
import type { Product } from "../scopes/types.ts";

// The product catalog: the materials a scope can use. It is mirrored nightly from Pruett POS once that sync exists; until then
// an admin keeps it by hand. Prices are Pruett RETAIL in cents; what A&A pays (Builder plan) is worked out in rules.ts.

export type CatalogErrorCode = "invalid_product" | "duplicate_sku" | "not_found" | "in_use";

export class CatalogError extends Error {
  code: CatalogErrorCode;
  constructor(code: CatalogErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

export type ProductInput = { sku: string; name: string; unit: string; priceText: string; specialOrder: boolean };
export type ValidProduct = { sku: string; name: string; unit: string; retailCents: number; specialOrder: boolean };

export const MAX_RETAIL_CENTS = 10_000_000; // $100,000 for one unit is a typo, never a shingle

export interface CatalogStore {
  list(): Promise<Product[]>;
  /** Throws duplicate_sku when the SKU is taken (ignoring upper/lower case). */
  create(p: ValidProduct): Promise<Product>;
  /** Throws not_found, or duplicate_sku when the new SKU belongs to another product. */
  update(id: string, p: ValidProduct): Promise<Product>;
  /** Throws not_found, or in_use when a scope line or a roofing assembly still points at it. */
  remove(id: string): Promise<void>;
}

/** Check what the admin typed. Returns the clean values to store; the price is parsed from text, never a float. */
export function validateProduct(input: ProductInput): ValidProduct {
  const bad = (m: string): never => { throw new CatalogError("invalid_product", m); };
  const sku = input.sku.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,39}$/.test(sku)) bad("The SKU should be letters, numbers, dots, dashes or slashes, up to 40 characters, with no spaces");
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) bad("The name should be 2 to 120 characters");
  const unit = input.unit.trim().toLowerCase();
  if (!/^[a-z]{1,8}$/.test(unit)) bad("The unit should be 1 to 8 letters, like sq, bundle, roll, ea or lf");
  const retailCents = parseDollarsToCents(input.priceText);
  if (retailCents === null) bad("Enter the price like 135.00");
  if (retailCents! > MAX_RETAIL_CENTS) bad("That price is too high for one unit");
  return { sku, name, unit, retailCents: retailCents!, specialOrder: input.specialOrder === true };
}

export const addProduct = (store: CatalogStore, input: ProductInput) => store.create(validateProduct(input));
export const changeProduct = (store: CatalogStore, id: string, input: ProductInput) => store.update(id, validateProduct(input));
export const removeProduct = (store: CatalogStore, id: string) => store.remove(id);
