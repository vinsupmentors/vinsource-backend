import fs from 'fs';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
// pdfjs-dist is used read-only, purely to find *where* a label like
// "Student Name:" sits on the page (pdf-lib has no text-search/positioning
// API of its own). Loaded via require() rather than `import` so this never
// needs @types/pdfjs-dist and never fails a type-check even if the package
// were ever missing — the actual value is only ever touched at runtime.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

interface StampMeta {
  signedByName: string;
  signedAt: Date;
  location?: string | null;
}

export interface HeaderField {
  /** Exact label text to find on the page, e.g. "Student Name:" */
  label: string;
  value: string;
}

interface FieldPosition {
  /** 0-indexed page, matching pdf-lib's pdfDoc.getPages() array. */
  page: number;
  x: number;
  y: number;
}

type TextItem = { str: string; width?: number; transform: number[] };

/**
 * Locate the blank line following a given label anywhere in a template
 * (e.g. finds where "____________" sits right after "Student Name:" on page
 * 1, but also "Name of Student:" in a Declaration section on the last page)
 * so we can draw the actual value on top of it. Works for any template that
 * follows the "Label: ____" convention used by the onboarding agreement
 * PDFs — template-agnostic, so a newly uploaded template with the same
 * convention is filled in automatically without any code change.
 *
 * Falls back to "right after the last item on the same line" when a label
 * has no underscore blank at all (e.g. this template's "Total Program Fee:"
 * line ends at "₹" with no visible rule) — the value still lands in a
 * sensible spot instead of being silently dropped.
 *
 * Scans every page rather than just the first — declaration sections near
 * the signature often repeat "Name of Student:"-style fields on the last
 * page of a multi-page agreement.
 */
async function locateFieldPositions(pdfBytes: Buffer, labels: string[]): Promise<Map<string, FieldPosition>> {
  const result = new Map<string, FieldPosition>();
  try {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
    const remaining = new Set(labels);

    for (let pageNum = 1; pageNum <= doc.numPages && remaining.size > 0; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = content.items as TextItem[];

      for (const label of Array.from(remaining)) {
        const idx = items.findIndex((it) => it.str.trim() === label);
        if (idx === -1) continue;
        const labelY = items[idx].transform[5];

        let blank: TextItem | undefined;
        let lastOnLine: TextItem = items[idx];
        for (let j = idx + 1; j < items.length; j++) {
          const item = items[j];
          if (Math.abs(item.transform[5] - labelY) > 1) break; // moved to a new line
          lastOnLine = item;
          if (item.str && /_{3,}/.test(item.str)) { blank = item; break; }
        }

        if (blank) {
          result.set(label, { page: pageNum - 1, x: blank.transform[4], y: labelY });
          remaining.delete(label);
        } else if (lastOnLine !== items[idx]) {
          // No blank line found, but something (e.g. "₹") follows the label —
          // place the value right after it instead of dropping it.
          result.set(label, { page: pageNum - 1, x: lastOnLine.transform[4] + (lastOnLine.width || 8), y: labelY });
          remaining.delete(label);
        } else {
          // Label is completely alone on its line — no underscore run, no
          // trailing text at all. Some templates draw the blank as a plain
          // vector line/rectangle rather than underscore characters (invisible
          // to text extraction), so there's nothing to anchor to. Fall back to
          // placing the value right after the label's own rendered width.
          const labelItem = items[idx];
          const estimatedWidth = labelItem.width ?? label.length * 5.5;
          result.set(label, { page: pageNum - 1, x: labelItem.transform[4] + estimatedWidth + 6, y: labelY });
          remaining.delete(label);
        }
      }
    }
  } catch {
    // If anything about locating fields fails, just skip filling them in —
    // the signature stamping below still proceeds normally.
  }
  return result;
}

/**
 * Locate a "☐"/"□" checkbox glyph immediately preceding a given choice label
 * anywhere in the document, e.g. the box right before the word "Offline" in
 * "Training Mode: ☐ Offline ☐ Online" — so a selected choice can be marked
 * with an "X" over it.
 */
async function locateCheckboxPosition(pdfBytes: Buffer, choiceLabel: string): Promise<FieldPosition | undefined> {
  try {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes) }).promise;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = content.items as TextItem[];

      const idx = items.findIndex((it) => it.str.trim() === choiceLabel);
      if (idx === -1) continue;
      const labelY = items[idx].transform[5];
      for (let j = idx - 1; j >= 0; j--) {
        const item = items[j];
        if (Math.abs(item.transform[5] - labelY) > 1) break; // moved to a previous line
        if (item.str && /[☐□]/.test(item.str)) {
          return { page: pageNum - 1, x: item.transform[4], y: item.transform[5] };
        }
      }
    }
  } catch {
    // Skip marking the checkbox if anything goes wrong locating it.
  }
  return undefined;
}

function detectMime(filePath: string): 'png' | 'jpg' {
  return filePath.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
}

async function embedRasterImage(pdfDoc: PDFDocument, bytes: Buffer, kind: 'png' | 'jpg') {
  // pdf-lib's Jpeg/Png embedders read `bytes.buffer` directly (assuming
  // byteOffset 0). Node's fs.readFileSync() returns a Buffer that, for small
  // files, is a *view into a shared pooled ArrayBuffer* — its `.buffer` is
  // much larger than the file itself, which pdf-lib misreads as corrupt data
  // ("SOI not found in JPEG"). Re-wrapping with `new Uint8Array(bytes)`
  // forces a fresh, exactly-sized ArrayBuffer at offset 0.
  const owned = new Uint8Array(bytes);
  return kind === 'png' ? pdfDoc.embedPng(owned) : pdfDoc.embedJpg(owned);
}

/**
 * Stamp a signature + selfie photo onto the bottom of the last page of an
 * existing PDF (a signed onboarding template, or a freshly generated fee
 * declaration) — produces one self-contained "signed copy" for admin review,
 * instead of showing the signature/photo as separate floating images.
 */
export async function stampSignatureOntoPdf(
  sourcePdfBytes: Buffer,
  signaturePath: string,
  photoPath: string,
  meta: StampMeta,
  headerFields?: HeaderField[],
  /** e.g. "Offline" or "Online" — marks the matching "☐ Offline ☐ Online"-style checkbox, wherever it appears. */
  checkboxChoice?: string
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(sourcePdfBytes));
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Fill in Student Name / ID / Mobile / Email / Course / Fee etc. wherever
  // their blank line appears — page 1 enrollment section, or a repeated
  // "Name of Student:" style field in a Declaration section further on —
  // before adding the signature block below.
  if (headerFields && headerFields.length > 0) {
    const positions = await locateFieldPositions(sourcePdfBytes, headerFields.map((f) => f.label));
    for (const field of headerFields) {
      const pos = positions.get(field.label);
      if (!pos || !field.value) continue;
      pages[pos.page]?.drawText(field.value, { x: pos.x + 2, y: pos.y + 2, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
    }
  }

  // Mark the selected Training Mode checkbox with an "X" over its "☐" glyph.
  if (checkboxChoice) {
    const checkboxPos = await locateCheckboxPosition(sourcePdfBytes, checkboxChoice);
    if (checkboxPos) {
      pages[checkboxPos.page]?.drawText('X', { x: checkboxPos.x + 1, y: checkboxPos.y + 0.5, size: 8, font: boldFont, color: rgb(0, 0, 0) });
    }
  }

  const signatureBytes = fs.readFileSync(signaturePath);
  const photoBytes = fs.readFileSync(photoPath);
  const signatureImage = await embedRasterImage(pdfDoc, signatureBytes, detectMime(signaturePath));
  const photoImage = await embedRasterImage(pdfDoc, photoBytes, detectMime(photoPath));

  const marginX = 40;
  const bottomY = 30;

  // Signature — fixed width, aspect-preserved.
  const sigTargetWidth = 130;
  const sigScale = sigTargetWidth / signatureImage.width;
  const sigHeight = signatureImage.height * sigScale;
  lastPage.drawImage(signatureImage, { x: marginX, y: bottomY + 16, width: sigTargetWidth, height: sigHeight });
  lastPage.drawLine({
    start: { x: marginX, y: bottomY + 12 },
    end: { x: marginX + sigTargetWidth, y: bottomY + 12 },
    thickness: 0.5,
    color: rgb(0.4, 0.4, 0.4),
  });
  lastPage.drawText('Student signature', { x: marginX, y: bottomY, size: 7, font, color: rgb(0.4, 0.4, 0.4) });

  // Photo — small fixed box next to the signature.
  const photoX = marginX + sigTargetWidth + 20;
  const photoW = 55;
  const photoScale = photoW / photoImage.width;
  const photoH = photoImage.height * photoScale;
  lastPage.drawImage(photoImage, { x: photoX, y: bottomY, width: photoW, height: photoH });

  // Signed-on / location caption to the right of the photo.
  const captionX = photoX + photoW + 20;
  // `en-IN` only controls date FORMATTING style (comma placement, month
  // names) — it does NOT convert the timezone. Without an explicit
  // `timeZone`, this renders in the server's own OS clock (UTC on the VPS),
  // not India time, silently showing a time ~5.5 hours behind the real one.
  const dateStr = meta.signedAt.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
  lastPage.drawText(`Digitally signed by ${meta.signedByName}`, { x: captionX, y: bottomY + 40, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
  lastPage.drawText(`on ${dateStr}`, { x: captionX, y: bottomY + 28, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
  if (meta.location) {
    lastPage.drawText(`from ${meta.location}`.slice(0, 70), { x: captionX, y: bottomY + 16, size: 8, font, color: rgb(0.2, 0.2, 0.2) });
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

function drawWrapped(page: PDFPage, font: PDFFont, text: string, x: number, y: number, maxWidth: number, size: number, lineHeight: number) {
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      page.drawText(line, { x, y, size, font });
      y -= lineHeight;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font });
    y -= lineHeight;
  }
  return y;
}

/**
 * Build a fresh single-page PDF for a per-student fee declaration from its
 * admin-entered fields — there's no source file for these (unlike a shared
 * OnboardingDocumentTemplate), so the whole document is generated here
 * before stampSignatureOntoPdf adds the signature/photo.
 */
export async function generateFeeDeclarationPdf(data: {
  studentName: string;
  guardianName: string | null;
  courseName: string | null;
  dueDate: Date | null;
  rows: { date?: string; totalFee?: string; feesPaid?: string; amountDue?: string }[];
}): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]); // US Letter
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 740;
  const marginX = 50;
  const lineHeight = 16;

  const drawLine = (text: string, opts: { size?: number; useBold?: boolean; center?: boolean } = {}) => {
    const size = opts.size ?? 10;
    const f = opts.useBold ? bold : font;
    const textWidth = f.widthOfTextAtSize(text, size);
    const x = opts.center ? (612 - textWidth) / 2 : marginX;
    page.drawText(text, { x, y, size, font: f });
    y -= lineHeight;
  };

  drawLine('Student Declaration Form for Pending Fee Payment', { size: 13, useBold: true, center: true });
  y -= 10;
  drawLine('To');
  drawLine('The Management,');
  drawLine('Vinsup Skill Academy,');
  drawLine('Ganapathy,');
  drawLine('Coimbatore – 641006.');
  y -= 8;
  drawLine('Subject: Declaration Regarding Pending Fee Payment', { useBold: true });
  y -= 8;

  const dueDateStr = data.dueDate
    ? new Date(data.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
  const paragraph = `I, ${data.studentName}, S/o or D/o ${data.guardianName || '—'}, enrolled in the course ${data.courseName || '—'}, hereby declare that I have pending fee dues with Vinsup Skill Academy and I take full responsibility to clear the dues on or before ${dueDateStr}.`;
  y = drawWrapped(page, font, paragraph, marginX, y, 512, 10, lineHeight);
  y -= 8;
  y = drawWrapped(
    page,
    font,
    'I understand that non-payment of the due amount within the stipulated time may lead to consequences including restriction from attending classes, withholding of certificates, or termination of enrollment.',
    marginX,
    y,
    512,
    10,
    lineHeight
  );
  y -= 16;

  // Fee schedule table
  const cols = [
    { label: 'Date', width: 110 },
    { label: 'Total Course Fees', width: 140 },
    { label: 'Fees Paid', width: 130 },
    { label: 'Amount Due', width: 132 },
  ];
  const rowHeight = 20;

  const drawRow = (values: string[], useBold: boolean) => {
    let x = marginX;
    for (let i = 0; i < cols.length; i++) {
      page.drawRectangle({ x, y: y - rowHeight, width: cols[i].width, height: rowHeight, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
      page.drawText(values[i] || '—', { x: x + 4, y: y - rowHeight + 6, size: 9, font: useBold ? bold : font });
      x += cols[i].width;
    }
    y -= rowHeight;
  };

  drawRow(cols.map((c) => c.label), true);
  for (const r of data.rows.slice(0, 15)) {
    drawRow([r.date || '', r.totalFee || '', r.feesPaid || '', r.amountDue || ''], false);
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
