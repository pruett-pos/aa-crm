import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { CONTRACT_TERMS_DRAFT } from "./terms.ts";

/**
 * Everything the customer's copy may show. There is deliberately no cost, margin or
 * commission field here, so those can never leak into a contract.
 */
export type ContractSection = {
  /** The trade, e.g. "Roofing". */
  divisionLabel: string;
  packageTitle: string;
  items: { description: string; quantity: number; unitPriceCents: number; color: string | null }[];
  subtotalCents: number;
};

export type ContractData = {
  jobNumber: number;
  customerName: string;
  propertyAddress: string;
  /** One section per trade on the job, each with the package the customer chose for it. */
  sections: ContractSection[];
  totalCents: number;
  depositCents: number;
  issuedOn: Date;
};

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The standard PDF fonts only cover Latin-1; swap anything else so drawing never throws. */
export function pdfSafe(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "?");
}

/**
 * Plain text of the contract, in reading order. Tested directly; the PDF just draws it.
 * `boldLines` are the indexes of lines drawn as headings (trade titles, subtotals, the grand total).
 */
export function contractText(d: ContractData): { heading: string; lines: string[]; boldLines: Set<number> } {
  const lines: string[] = [
    `Contract for job ${d.jobNumber}`,
    `Date: ${d.issuedOn.toISOString().slice(0, 10)}`,
    `Customer: ${d.customerName}`,
    `Property: ${d.propertyAddress}`,
    "",
    "Scope of work",
  ];
  const bold = new Set<number>([lines.length - 1]);
  const multi = d.sections.length > 1;
  for (const s of d.sections) {
    bold.add(lines.length);
    lines.push(`${s.divisionLabel}: ${s.packageTitle}`);
    for (const i of s.items) {
      const total = Math.round(i.quantity * i.unitPriceCents);
      const color = i.color ? ` (${i.color})` : "";
      lines.push(`${i.description}${color} - ${i.quantity} x ${money(i.unitPriceCents)} = ${money(total)}`);
    }
    if (multi) {
      bold.add(lines.length);
      lines.push(`${s.divisionLabel} subtotal: ${money(s.subtotalCents)}`);
    }
    lines.push("");
  }
  bold.add(lines.length);
  lines.push(`Total price: ${money(d.totalCents)}`);
  lines.push(
    d.depositCents > 0
      ? `Deposit due before materials are ordered: ${money(d.depositCents)}`
      : "No deposit is required before work begins.",
  );
  lines.push("", ...CONTRACT_TERMS_DRAFT);
  return { heading: "A&A Exterior Group - Contract", lines, boldLines: bold };
}

export function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) line = next;
    else { out.push(line); line = word; }
  }
  out.push(line);
  return out;
}

const W = 612, H = 792, M = 54, LH = 15, SIZE = 10.5;
const NAVY = rgb(0x1f / 255, 0x3a / 255, 0x5f / 255);

// Where the signature and date go is recorded in the PDF's keywords, so signing can
// overlay the customer's mark on the exact document they were shown.
type Spot = { page: number; x: number; y: number };
const KEY = "aa-sign";
function spotsToKeywords(sig: Spot, date: Spot): string {
  return `${KEY}:sig=${sig.page},${sig.x},${sig.y};date=${date.page},${date.x},${date.y}`;
}
export function spotsFromKeywords(keywords: string | undefined): { sig: Spot; date: Spot } | null {
  const m = keywords?.match(/aa-sign:sig=(\d+),([\d.]+),([\d.]+);date=(\d+),([\d.]+),([\d.]+)/);
  if (!m) return null;
  return {
    sig: { page: +m[1], x: +m[2], y: +m[3] },
    date: { page: +m[4], x: +m[5], y: +m[6] },
  };
}

/** Render the unsigned contract with signature and date lines. */
export async function renderContractPdf(d: ContractData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { heading, lines, boldLines } = contractText(d);

  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ensure = (needed: number) => {
    if (y - needed < M) { page = pdf.addPage([W, H]); y = H - M; }
  };

  page.drawText(pdfSafe(heading), { x: M, y, size: 18, font: bold, color: NAVY });
  y -= 30;
  for (const [index, raw] of lines.entries()) {
    const f = boldLines.has(index) ? bold : font;
    for (const part of wrap(pdfSafe(raw), f, SIZE, W - 2 * M)) {
      ensure(LH);
      page.drawText(part, { x: M, y, size: SIZE, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= LH;
    }
  }

  ensure(120);
  y -= 40;
  const pageIndex = pdf.getPageCount() - 1;
  const sigY = y;
  page.drawText("Customer signature:", { x: M, y: sigY, size: SIZE, font: bold });
  page.drawLine({ start: { x: M + 125, y: sigY - 4 }, end: { x: M + 340, y: sigY - 4 }, thickness: 0.5 });
  const dateY = sigY - 46;
  page.drawText("Date:", { x: M, y: dateY, size: SIZE, font: bold });
  page.drawLine({ start: { x: M + 125, y: dateY - 4 }, end: { x: M + 340, y: dateY - 4 }, thickness: 0.5 });

  pdf.setKeywords([spotsToKeywords(
    { page: pageIndex, x: M + 127, y: sigY - 2 },
    { page: pageIndex, x: M + 127, y: dateY },
  )]);
  return pdf.save();
}

export type SignatureEvidence = {
  signerName: string;
  signerEmail: string;
  signaturePng: Uint8Array;
  signedAt: Date;
  consentAt: Date;
  ip: string | null;
  userAgent: string | null;
  unsignedSha256: string;
  jobNumber: number;
  estimatorName: string;
};

/**
 * Overlay the customer's signature on the unsigned contract and append a certificate page.
 * The original pages are untouched, so the signed PDF is the same document the customer saw.
 */
export async function renderSignedContractPdf(unsigned: Uint8Array, ev: SignatureEvidence): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(unsigned);
  const spots = spotsFromKeywords(pdf.getKeywords());
  if (!spots) throw new Error("Contract PDF has no signature position");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const sigPage = pdf.getPage(spots.sig.page);
  const png = await pdf.embedPng(ev.signaturePng);
  const maxW = 200, maxH = 44;
  const scale = Math.min(maxW / png.width, maxH / png.height, 1);
  sigPage.drawImage(png, { x: spots.sig.x, y: spots.sig.y, width: png.width * scale, height: png.height * scale });
  pdf.getPage(spots.date.page).drawText(ev.signedAt.toISOString().slice(0, 10), {
    x: spots.date.x, y: spots.date.y, size: SIZE, font,
  });
  sigPage.drawText(pdfSafe(`Signed by ${ev.signerName}`), { x: spots.sig.x, y: spots.sig.y - 16, size: 8, font, color: rgb(0.35, 0.35, 0.35) });

  const cert = pdf.addPage([W, H]);
  let y = H - M;
  cert.drawText("Certificate of signature", { x: M, y, size: 18, font: bold, color: NAVY });
  y -= 30;
  const rows: [string, string][] = [
    ["Job", String(ev.jobNumber)],
    ["Signer name", ev.signerName],
    ["Signer email", ev.signerEmail],
    ["Consent to electronic records", ev.consentAt.toISOString()],
    ["Signed (UTC)", ev.signedAt.toISOString()],
    ["Method", `In person, on a device run by ${ev.estimatorName}`],
    ["IP address", ev.ip ?? "not recorded"],
    ["Device", ev.userAgent ?? "not recorded"],
    ["Original document SHA-256", ev.unsignedSha256],
  ];
  for (const [label, value] of rows) {
    cert.drawText(pdfSafe(label), { x: M, y, size: 9, font: bold });
    y -= 13;
    for (const part of wrap(pdfSafe(value), font, 9, W - 2 * M)) {
      cert.drawText(part, { x: M, y, size: 9, font });
      y -= 12;
    }
    y -= 6;
  }
  y -= 6;
  for (const part of wrap(
    "The original document pages above are unchanged from what the signer reviewed; this page and the signature mark were added when it was signed. The SHA-256 above identifies the original unsigned file.",
    font, 9, W - 2 * M,
  )) {
    cert.drawText(part, { x: M, y, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
    y -= 12;
  }
  return pdf.save();
}
