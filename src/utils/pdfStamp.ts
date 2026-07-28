import fs from 'fs';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

interface StampMeta {
  signedByName: string;
  signedAt: Date;
  location?: string | null;
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
  meta: StampMeta
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(sourcePdfBytes));
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

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
  const dateStr = meta.signedAt.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
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
