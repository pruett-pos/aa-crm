import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfSafe, wrap } from "../contracts/pdf.ts";
import type { WorkOrderPdfData } from "./logic.ts";

const W = 612, H = 792, M = 54, LH = 15, SIZE = 10.5;
const NAVY = rgb(0x1f / 255, 0x3a / 255, 0x5f / 255);
const BRASS = rgb(0xd4 / 255, 0xa2 / 255, 0x4c / 255);

const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));

/**
 * Plain text of a work order, in reading order. Tested directly; the PDF just draws it. There is no price, cost, rate or margin
 * anywhere in the data this is built from, and no customer name or phone either: a crew works from the address.
 */
export function workOrderText(d: WorkOrderPdfData): { heading: string; lines: string[]; boldLines: Set<number> } {
  const lines: string[] = [
    `Job ${d.jobNumber}: ${d.tradeLabel}`,
    d.status === "draft" ? "DRAFT - not issued yet" : `Issued ${d.issuedOn ?? ""}`.trim(),
    `Address: ${d.address}`,
    `Install date: ${d.installDate ?? "not scheduled yet"}`,
    `Crew leader: ${d.crewLeaderName ?? "not assigned yet"}`,
    "",
  ];
  const bold = new Set<number>([0]);
  if (d.notes) {
    bold.add(lines.length); lines.push("Notes");
    lines.push(d.notes, "");
  }
  bold.add(lines.length); lines.push("Tasks");
  if (d.tasks.length === 0) lines.push("No tasks.");
  d.tasks.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.description} - ${qty(t.quantity)} ${t.unit}`);
    if (t.note) lines.push(`    Note: ${t.note}`);
  });
  lines.push("");
  bold.add(lines.length); lines.push("Materials and colors");
  if (d.materials.length === 0) lines.push("None on the signed scope.");
  for (const m of d.materials) lines.push(`${m.description} - ${qty(m.quantity)} ${m.unit} - ${m.color ?? "color not chosen yet"}`);
  return { heading: "A&A Exterior Group - Work order", lines, boldLines: bold };
}

export async function renderWorkOrderPdf(d: WorkOrderPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const { heading, lines, boldLines } = workOrderText(d);

  let page = pdf.addPage([W, H]);
  let y = H - M;
  const ensure = (needed: number) => { if (y - needed < M) { page = pdf.addPage([W, H]); y = H - M; } };

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
  pdf.setTitle(`Work order - job ${d.jobNumber} - ${d.tradeLabel}`);
  return pdf.save();
}
