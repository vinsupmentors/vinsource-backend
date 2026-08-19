// @ts-ignore – pdfkit has no bundled types; works fine at runtime
import PDFDocument from 'pdfkit';
import path from 'path';

export interface CertificatePdfData {
  type: 'COURSE_COMPLETION' | 'INTERNSHIP';
  studentName: string;
  studentCode: string;
  courseName?: string | null;
  certificateNo: string;
  issuedOn: Date;
  feeApproverName: string;
  ldmApproverName: string;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

/**
 * Auto-generates a real, presentable certificate PDF the moment both
 * approvals (Fee + LDM) are in place — no manual finishing step. Landscape
 * A4, decorative border, Vinsup letterhead. Two variants share this layout:
 * Course Completion (names the course) and Internship (names the program).
 */
export async function generateCertificatePdf(data: CertificatePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ layout: 'landscape', size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const navy = '#1e3a8a';
    const gold = '#b45309';
    const ink = '#1f2937';
    const muted = '#6b7280';

    // ── Decorative border ──────────────────────────────────────────────
    doc.rect(24, 24, pageW - 48, pageH - 48).lineWidth(2).strokeColor(navy).stroke();
    doc.rect(32, 32, pageW - 64, pageH - 64).lineWidth(0.75).strokeColor(gold).stroke();

    // ── Logo ──────────────────────────────────────────────────────────
    const logoPath = path.join(process.cwd(), 'assets', 'vinsup-logo.png');
    try {
      doc.image(logoPath, pageW / 2 - 65, 55, { width: 130 });
    } catch (_) {
      doc.fontSize(16).font('Helvetica-Bold').fillColor(navy)
        .text('VINSUP SKILL ACADEMY', 0, 60, { align: 'center', width: pageW });
    }

    let y = 135;

    // ── Title ─────────────────────────────────────────────────────────
    const title = data.type === 'COURSE_COMPLETION' ? 'Certificate of Completion' : 'Certificate of Internship';
    doc.fontSize(26).font('Helvetica-Bold').fillColor(navy)
      .text(title, 0, y, { align: 'center', width: pageW });
    y += 42;

    doc.moveTo(pageW / 2 - 70, y).lineTo(pageW / 2 + 70, y).lineWidth(1.2).strokeColor(gold).stroke();
    y += 28;

    // ── Preamble ──────────────────────────────────────────────────────
    doc.fontSize(12).font('Helvetica').fillColor(muted)
      .text('This is to certify that', 0, y, { align: 'center', width: pageW });
    y += 26;

    // ── Student name ──────────────────────────────────────────────────
    doc.fontSize(28).font('Helvetica-Bold').fillColor(ink)
      .text(data.studentName, 0, y, { align: 'center', width: pageW });
    y += 46;

    // ── Body ──────────────────────────────────────────────────────────
    const body = data.type === 'COURSE_COMPLETION'
      ? `(Student Code: ${data.studentCode}) has successfully completed the course "${data.courseName || 'the assigned program'}" conducted by Vinsup Skill Academy, fulfilling all academic and evaluation requirements.`
      : `(Student Code: ${data.studentCode}) has successfully completed the Internship Program at Vinsup Skill Academy, demonstrating practical, job-ready skills through a reviewed and approved project portfolio.`;
    doc.fontSize(12).font('Helvetica').fillColor(ink)
      .text(body, pageW / 2 - 300, y, { align: 'center', width: 600, lineGap: 4 });
    y = doc.y + 30;

    // ── Certificate No. / Date ───────────────────────────────────────
    doc.fontSize(10).font('Helvetica-Bold').fillColor(muted)
      .text(`Certificate No: ${data.certificateNo}`, 0, y, { align: 'center', width: pageW });
    y += 16;
    doc.font('Helvetica').text(`Issued on ${fmtDate(data.issuedOn)}`, 0, y, { align: 'center', width: pageW });

    // ── Sign-off block (bottom) ──────────────────────────────────────
    const signY = pageH - 110;
    const colW = 220;
    const leftX = pageW / 2 - colW - 30;
    const rightX = pageW / 2 + 30;

    doc.moveTo(leftX, signY).lineTo(leftX + colW, signY).lineWidth(0.75).strokeColor(muted).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor(ink).text(data.feeApproverName, leftX, signY + 6, { width: colW, align: 'center' });
    doc.fontSize(8).font('Helvetica').fillColor(muted).text('Fee / Admin Approval', leftX, signY + 20, { width: colW, align: 'center' });

    doc.moveTo(rightX, signY).lineTo(rightX + colW, signY).lineWidth(0.75).strokeColor(muted).stroke();
    doc.fontSize(10).font('Helvetica-Bold').fillColor(ink).text(data.ldmApproverName, rightX, signY + 6, { width: colW, align: 'center' });
    doc.fontSize(8).font('Helvetica').fillColor(muted).text('LDM Approval', rightX, signY + 20, { width: colW, align: 'center' });

    doc.fontSize(8).font('Helvetica').fillColor(muted)
      .text('Vinsup Skill Academy · 148 A,B, Gopalaswamy Kovil Street, Ganapathy, Coimbatore - 641006', 0, pageH - 44, { align: 'center', width: pageW });

    doc.end();
  });
}
