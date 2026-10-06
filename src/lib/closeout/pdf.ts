import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfSafe, wrap } from "../contracts/pdf.ts";

/**
 * Everything the customer's invoice may show. There is deliberately no cost, margin or commission field here,
 * so those can never leak into an invoice.
 */
export type InvoiceData = {
  invoiceNumber: number;
  jobNumber: number;
  customerName: string;
  propertyAddress: string;
  issuedOn: string;            // YYYY-MM-DD
  dueOn: string;               // YYYY-MM-DD
  /** One line per trade: the package the customer chose and its price. */
  sections: { divisionLabel: string; packageTitle: string; subtotalCents: number }[];
  contractCents: number;
  paidCents: number;
  balanceCents: number;
};

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Plain text of the invoice in reading order. Tested directly; the PDF just draws it. */
export function invoiceText(d: InvoiceData): { heading: string; lines: string[]; boldLines: Set<number> } {
  const lines: string[] = [
    `Invoice ${d.invoiceNumber}`,
    `Date: ${d.issuedOn}`,
    d.dueOn === d.issuedOn ? "Due: on receipt" : `Due: ${d.dueOn}`,
    `Job: ${d.jobNumber}`,
    `Customer: ${d.customerName}`,
    `Property: ${d.propertyAddress}`,
    "",
    "Work completed",
  ];
  const bold = new Set<number>([lines.length - 1]);
  for (const s of d.sections) lines.push(`${s.divisionLabel}: ${s.packageTitle} - ${money(s.subtotalCents)}`);
  lines.push("");
  lines.push(`Total contract price: ${money(d.contractCents)}`);
  lines.push(`Payments received: ${money(d.paidCents)}`);
  bold.add(lines.length);
  lines.push(`Balance due: ${money(d.balanceCents)}`);
  lines.push("");
  lines.push(d.balanceCents === 0 ? "This invoice is paid in full. Thank you." : "Terms: due on receipt.");
  if (d.balanceCents > 0) {
    lines.push("Make checks payable to A&A Exterior Group, or contact our office to pay by card.");
  }
  return { heading: "A&A Exterior Group - Invoice", lines, boldLines: bold };
}

const W = 612, H = 792, M = 54, LH = 15, SIZE = 10.5;
const NAVY = rgb(0x1f / 255, 0x3a / 255, 0x5f / 255);
const BRASS = rgb(0xd4 / 255, 0xa2 / 255, 0x4c / 255);

export async function renderInvoicePdf(d: InvoiceData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { heading, lines, boldLines } = invoiceText(d);

  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ensure = (needed: number) => {
    if (y - needed < M) { page = pdf.addPage([W, H]); y = H - M; }
  };

  page.drawText(pdfSafe(heading), { x: M, y, size: 18, font: bold, color: NAVY });
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 2, color: BRASS });
  y -= 24;
  for (const [index, raw] of lines.entries()) {
    const f = boldLines.has(index) ? bold : font;
    for (const part of wrap(pdfSafe(raw), f, SIZE, W - 2 * M)) {
      ensure(LH);
      page.drawText(part, { x: M, y, size: SIZE, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= LH;
    }
  }
  pdf.setTitle(`Invoice ${d.invoiceNumber}`);
  return pdf.save();
}

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
