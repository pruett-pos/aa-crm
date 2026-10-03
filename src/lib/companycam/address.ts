const ABBREVIATIONS: Record<string, string> = {
  st: "street", rd: "road", dr: "drive", ln: "lane", ave: "avenue", av: "avenue", blvd: "boulevard", ct: "court", cir: "circle",
  hwy: "highway", pkwy: "parkway", pl: "place", trl: "trail", ter: "terrace", n: "north", s: "south", e: "east", w: "west",
  ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
};

/** "100 N. Example Rd." and "100 north example road" compare equal. */
export function normalizeStreet(s: string): string {
  return s.toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean).map((w) => ABBREVIATIONS[w] ?? w).join(" ");
}

const DIRECTIONS = new Set(["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest"]);

/**
 * A search word that finds the street however it is spelled: the first word of the street name, skipping the house number
 * and compass directions ("100 N. Example Rd" -> "example"). CompanyCam matches on contains, so the full street would miss "Road" vs "Rd".
 */
export function streetSearchWord(street: string): string {
  const words = normalizeStreet(street).split(" ").filter((w) => w && !/^\d/.test(w) && !DIRECTIONS.has(w));
  return words[0] ?? normalizeStreet(street);
}

/** Same street (ignoring abbreviations and punctuation) and same 5-digit zip. A missing zip never matches. */
export function sameAddress(
  cc: { street: string | null; postalCode: string | null }, job: { street: string; zip: string },
): boolean {
  if (!cc.street || !cc.postalCode) return false;
  return normalizeStreet(cc.street) === normalizeStreet(job.street) && cc.postalCode.slice(0, 5) === job.zip.slice(0, 5);
}
