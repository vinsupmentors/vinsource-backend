import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

// Fixed policy lines shown on every receipt — matches the wording already in
// use on the existing external billing tool's receipts (see the
// VSA-000806/08/2026 sample). Kept as a constant so updating the wording
// later is a one-line change here rather than a PDF-drawing rewrite.
const TERMS = [
  'All fees once paid are strictly non-refundable under any circumstances.',
  'Batch transfer is permitted only upon payment of a penalty fee.',
];

const NAVY = rgb(0.11, 0.16, 0.32);
const GREY = rgb(0.45, 0.45, 0.45);
const LIGHT_GREY = rgb(0.93, 0.93, 0.95);
const BORDER = rgb(0.75, 0.75, 0.78);

export interface ReceiptTransaction {
  mode: string;
  date: Date;
  amount: number;
  receiptNo?: string;  // the bill number issued for this payment
  current?: boolean;   // true for the payment this bill is being issued for
}

export interface ReceiptData {
  receiptNo: string; // e.g. "VSA-000806/08/2026"
  billToName: string;
  billToAddress?: string | null;
  billToCity?: string | null;
  billToState?: string | null;
  billToPincode?: string | null;
  paymentDate: Date;
  dueDate?: Date | null;
  itemName: string; // e.g. "Digital Marketing - IOP"
  totalFee: number;
  totalPaid: number;
  transactions: ReceiptTransaction[];
  stageLabel?: string; // lead stage, e.g. "Registration Done"
  paidNow?: number;    // amount of the payment this bill is for
  trackLabel?: string; // e.g. "IOP"
}

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD, matches the sample
}

function fmtMoney(n: number): string {
  // NOTE: deliberately "Rs." not "₹" — pdf-lib's standard Helvetica font only
  // supports WinAnsi encoding, which has no Rupee-sign glyph. Drawing "₹"
  // with a standard font throws inside pdf-lib, which silently kills the
  // whole receipt email (the throw happens before emailService.send is ever
  // called, so nothing gets logged either).
  return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function drawWrapped(page: PDFPage, font: PDFFont, text: string, x: number, y: number, maxWidth: number, size: number, lineHeight: number, color = rgb(0, 0, 0)) {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      page.drawText(line, { x, y, size, font, color });
      y -= lineHeight;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font, color });
    y -= lineHeight;
  }
  return y;
}

/**
 * Build a self-contained receipt PDF — one per fee collection (initial
 * payment or any later installment) — in the same layout as the existing
 * VSA-######/MM/YYYY receipts: header, Bill To, single course line item,
 * Sub Total/Total/Total Paid/Amount Due summary, a running transactions
 * table (every payment collected against this plan so far), and terms.
 * Status ("Paid in Full" vs "Partially Paid") is derived from the totals
 * rather than passed in, so it can never drift from the numbers on the page.
 */
export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 portrait
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595;
  const marginX = 45;
  const rightX = pageWidth - marginX;

  const amountDue = Math.max(0, data.totalFee - data.totalPaid);
  const isPaidInFull = amountDue <= 0.005;
  const statusLabel = isPaidInFull ? 'PAID IN FULL' : 'PARTIALLY PAID';
  const statusColor = isPaidInFull ? rgb(0.06, 0.5, 0.25) : rgb(0.85, 0.45, 0.05);

  let y = 780;

  // ── Header ──────────────────────────────────────────────────────────────
  // Vinsup logo (best-effort: a missing/unreadable file must never block the bill).
  let textX = marginX;
  try {
    const logoPath = path.join(process.cwd(), 'assets', 'vinsup-logo.png');
    if (fs.existsSync(logoPath)) {
      const logo = await pdfDoc.embedPng(fs.readFileSync(logoPath));
      const h = 48;
      const w = (logo.width / logo.height) * h;
      page.drawImage(logo, { x: marginX, y: 745, width: Math.min(w, 140), height: h });
      textX = marginX + Math.min(w, 140) + 12;
    }
  } catch { /* ignore, header falls back to text only */ }

  page.drawText('Vinsup Skill Academy', { x: textX, y, size: 16, font: bold, color: NAVY });
  const receiptTitleW = bold.widthOfTextAtSize('RECEIPT', 20);
  page.drawText('RECEIPT', { x: rightX - receiptTitleW, y: y + 4, size: 20, font: bold, color: NAVY });
  y -= 20;
  page.drawText('148 A,B, Gopalaswamy Kovil Street, Ganapathy', { x: textX, y, size: 9, font, color: GREY });
  const receiptNoW = font.widthOfTextAtSize(`# ${data.receiptNo}`, 10);
  page.drawText(`# ${data.receiptNo}`, { x: rightX - receiptNoW, y: y + 3, size: 10, font, color: GREY });
  y -= 13;
  page.drawText('Coimbatore, Tamil Nadu, IN 641006', { x: textX, y, size: 9, font, color: GREY });
  const statusW = bold.widthOfTextAtSize(statusLabel, 10);
  page.drawText(statusLabel, { x: rightX - statusW, y: y + 2, size: 10, font: bold, color: statusColor });
  if (data.stageLabel) {
    const stageLine = `Stage: ${data.stageLabel}`;
    page.drawText(stageLine, { x: rightX - bold.widthOfTextAtSize(stageLine, 9), y: y - 11, size: 9, font: bold, color: NAVY });
  }
  y -= 36;

  page.drawLine({ start: { x: marginX, y }, end: { x: rightX, y }, thickness: 1, color: BORDER });
  y -= 22;

  // ── Bill To ─────────────────────────────────────────────────────────────
  page.drawText('Bill To', { x: marginX, y, size: 9, font: bold, color: GREY });
  y -= 14;
  page.drawText(data.billToName, { x: marginX, y, size: 11, font: bold, color: rgb(0, 0, 0) });
  y -= 15;
  const addrParts = [data.billToAddress, data.billToCity, data.billToState].filter(Boolean).join(', ');
  if (addrParts) { page.drawText(addrParts, { x: marginX, y, size: 9, font, color: GREY }); y -= 13; }
  if (data.billToPincode) { page.drawText(`IN ${data.billToPincode}`, { x: marginX, y, size: 9, font, color: GREY }); y -= 13; }

  // Payment / due dates — right aligned, same vertical band as Bill To.
  let datesY = 780 - 58;
  const paymentLine = `Payment Date: ${fmtDate(data.paymentDate)}`;
  page.drawText(paymentLine, { x: rightX - font.widthOfTextAtSize(paymentLine, 9), y: datesY, size: 9, font, color: GREY });
  datesY -= 13;
  if (data.dueDate) {
    const dueLine = `Due Date: ${fmtDate(data.dueDate)}`;
    page.drawText(dueLine, { x: rightX - font.widthOfTextAtSize(dueLine, 9), y: datesY, size: 9, font, color: GREY });
  }

  y -= 20;

  // ── Course details ──────────────────────────────────────────────────────
  const detailRows: [string, string][] = [['Course Opted', data.itemName]];
  if (data.trackLabel) detailRows.push(['Track', data.trackLabel]);
  detailRows.push(['Total Fees', fmtMoney(data.totalFee)]);
  for (const [label, val] of detailRows) {
    page.drawText(`${label}:`, { x: marginX, y, size: 10, font: bold, color: GREY });
    page.drawText(val, { x: marginX + 95, y, size: 10, font: bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 16;
  }
  y -= 8;

  // ── Item table ──────────────────────────────────────────────────────────
  const cols = [
    { label: '#', width: 25 },
    { label: 'Item', width: 300 },
    { label: 'Rate', width: 90 },
    { label: 'Amount', width: rightX - marginX - 25 - 300 - 90 },
  ];
  const rowH = 24;

  page.drawRectangle({ x: marginX, y: y - rowH, width: rightX - marginX, height: rowH, color: NAVY });
  let cx = marginX;
  const headerVals = ['#', 'Item', 'Rate', 'Amount'];
  for (let i = 0; i < cols.length; i++) {
    const align = i >= 2 ? 'right' : 'left';
    const val = headerVals[i];
    const tx = align === 'right' ? cx + cols[i].width - 8 - bold.widthOfTextAtSize(val, 9) : cx + 8;
    page.drawText(val, { x: tx, y: y - rowH + 8, size: 9, font: bold, color: rgb(1, 1, 1) });
    cx += cols[i].width;
  }
  y -= rowH;

  cx = marginX;
  // Row = what was received today (this bill); falls back to the full fee for old callers.
  const todayAmt = data.paidNow ?? data.totalFee;
  const itemVals = ['1', data.paidNow ? `Payment received today - ${data.itemName}` : data.itemName, fmtMoney(todayAmt), fmtMoney(todayAmt)];
  for (let i = 0; i < cols.length; i++) {
    page.drawRectangle({ x: cx, y: y - rowH, width: cols[i].width, height: rowH, borderColor: BORDER, borderWidth: 0.5 });
    const align = i >= 2 ? 'right' : 'left';
    const val = itemVals[i];
    const tx = align === 'right' ? cx + cols[i].width - 8 - font.widthOfTextAtSize(val, 9) : cx + 8;
    page.drawText(val, { x: tx, y: y - rowH + 8, size: 9, font: i === 1 ? bold : font, color: rgb(0.1, 0.1, 0.1) });
    cx += cols[i].width;
  }
  y -= rowH + 16;

  // ── Summary ─────────────────────────────────────────────────────────────
  const summaryRows: [string, string, boolean][] = [
    ['Sub Total', fmtMoney(todayAmt), false],
    ['Total', fmtMoney(todayAmt), false],
    ['Total Paid (all bills)', fmtMoney(data.totalPaid), false],
    ['Amount Due', fmtMoney(amountDue), true],
  ];
  const summaryLabelX = rightX - 220;
  for (const [label, val, emphasize] of summaryRows) {
    if (emphasize) page.drawRectangle({ x: summaryLabelX - 8, y: y - 4, width: 220 + 8, height: 18, color: LIGHT_GREY });
    page.drawText(label, { x: summaryLabelX, y, size: 10, font: bold, color: rgb(0.1, 0.1, 0.1) });
    const valW = bold.widthOfTextAtSize(val, 10);
    page.drawText(val, { x: rightX - valW, y, size: 10, font: bold, color: emphasize ? statusColor : rgb(0.1, 0.1, 0.1) });
    y -= 20;
  }
  y -= 12;

  // ── Transactions ────────────────────────────────────────────────────────
  page.drawText('Transactions', { x: marginX, y, size: 11, font: bold, color: NAVY });
  y -= 18;
  const txCols = [
    { label: 'Bill No', width: 190 },
    { label: 'Payment Mode', width: 110 },
    { label: 'Date', width: 90 },
    { label: 'Amount', width: rightX - marginX - 190 - 110 - 90 },
  ];
  cx = marginX;
  txCols.forEach((c, i) => {
    const hx = i === txCols.length - 1 ? cx + c.width - bold.widthOfTextAtSize(c.label, 9) : cx;
    page.drawText(c.label, { x: hx, y, size: 9, font: bold, color: GREY });
    cx += c.width;
  });
  y -= 6;
  page.drawLine({ start: { x: marginX, y }, end: { x: rightX, y }, thickness: 0.5, color: BORDER });
  y -= 14;

  for (const t of data.transactions.slice(0, 20)) {
    cx = marginX;
    if (t.current) page.drawRectangle({ x: marginX - 4, y: y - 4, width: rightX - marginX + 8, height: 15, color: LIGHT_GREY });
    const vals = [`${t.receiptNo || '-'}${t.current ? '  (this bill)' : ''}`, t.mode.replace(/_/g, ' '), fmtDate(t.date), fmtMoney(t.amount)];
    for (let i = 0; i < txCols.length; i++) {
      const align = i === 3 ? 'right' : 'left';
      const tx = align === 'right' ? cx + txCols[i].width - font.widthOfTextAtSize(vals[i], 9) : cx;
      page.drawText(vals[i], { x: tx, y, size: 9, font: t.current ? bold : font, color: rgb(0.1, 0.1, 0.1) });
      cx += txCols[i].width;
    }
    y -= 16;
  }
  y -= 16;

  // ── Terms & Conditions ──────────────────────────────────────────────────
  page.drawText('Terms & Conditions', { x: marginX, y, size: 11, font: bold, color: NAVY });
  y -= 18;
  TERMS.forEach((term, i) => {
    y = drawWrapped(page, font, `${i + 1}. ${term}`, marginX, y, rightX - marginX, 9, 13, GREY);
    y -= 4;
  });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
