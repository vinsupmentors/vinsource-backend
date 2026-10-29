import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { bookedVsConducted, booking, todayDemo, bookingResponse, demoResponse, studentResponse, editDemoFields, saveTarget } from '../utils/reportSheetsLive';
import { approval, paymentDetails, loan, addLoan, editLoan, verifyLoan, jodo, importJodo } from '../utils/reportSheetsRevenue';

interface Cell { v: string; bg?: string; fg?: string; b?: 1; i?: 1; al?: 'l' | 'c' | 'r' }
interface SheetContent { rows: number; cols: number; colWidths: number[]; rowHeights: Record<string, number>; merges: { r: number; c: number; rs: number; cs: number }[]; cells: Record<string, Cell>; frozenRows: number }

const blank = (): SheetContent => ({ rows: 40, cols: 12, colWidths: Array(12).fill(110), rowHeights: {}, merges: [], cells: {}, frozenRows: 0 });

/** The BRD Tracker's five sheets are live reports built from the Sales data. */
const BRD_LIVE: { name: string; liveKey: string }[] = [
  { name: 'Booking', liveKey: 'BOOKING' },
  { name: 'Booked VS Conducted', liveKey: 'BOOKED_VS_CONDUCTED' },
  { name: 'Today Demo', liveKey: 'TODAY_DEMO' },
  { name: 'Booking Response', liveKey: 'BOOKING_RESPONSE' },
  { name: 'Demo Response', liveKey: 'DEMO_RESPONSE' },
  { name: 'Student Response', liveKey: 'STUDENT_RESPONSE' },
];

const REVENUE_LIVE: { name: string; liveKey: string }[] = [
  { name: 'Approval', liveKey: 'REV_APPROVAL' },
  { name: 'Payment Details', liveKey: 'REV_PAYMENT_DETAILS' },
  { name: 'Loan', liveKey: 'REV_LOAN' },
  { name: 'Jodo', liveKey: 'REV_JODO' },
];

/** Idempotent: make sure a spreadsheet exists with its live sheets (converting any earlier static copy). */
async function ensureLiveBook(bookName: string, defs: { name: string; liveKey: string }[]) {
  let book = await prisma.reportBook.findFirst({ where: { name: bookName } });
  if (!book) book = await prisma.reportBook.create({ data: { name: bookName } });
  const sheets = await prisma.reportSheet.findMany({ where: { bookId: book.id } });
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const existing = sheets.find((s) => s.liveKey === def.liveKey) || sheets.find((s) => s.name === def.name && s.kind !== 'LIVE');
    if (!existing) await prisma.reportSheet.create({ data: { bookId: book.id, name: def.name, sortOrder: i, kind: 'LIVE', liveKey: def.liveKey, content: {} } });
    else if (existing.kind !== 'LIVE') await prisma.reportSheet.update({ where: { id: existing.id }, data: { kind: 'LIVE', liveKey: def.liveKey, sortOrder: i, content: {} } });
  }
}
const ensureBrd = async () => { await ensureLiveBook('BRD Tracker', BRD_LIVE); await ensureLiveBook('Revenue Consideration', REVENUE_LIVE); };

export const reportSheetsController = {
  async listBooks(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await ensureBrd();
      const books = await prisma.reportBook.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true, updatedAt: true, _count: { select: { sheets: true } } } });
      res.json({ success: true, data: books });
    } catch (err) { next(err); }
  },

  async getBook(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const book = await prisma.reportBook.findUnique({ where: { id: req.params.id }, include: { sheets: { orderBy: { sortOrder: 'asc' } } } });
      if (!book) throw new AppError('Spreadsheet not found', 404);
      res.json({ success: true, data: book });
    } catch (err) { next(err); }
  },

  async createBook(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) throw new AppError('Give the spreadsheet a name', 400);
      const book = await prisma.reportBook.create({ data: { name, createdById: req.user?.employeeId || null, sheets: { create: [{ name: 'Sheet1', sortOrder: 0, content: blank() as object }] } } });
      res.status(201).json({ success: true, data: book });
    } catch (err) { next(err); }
  },

  async renameBook(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) throw new AppError('Give the spreadsheet a name', 400);
      res.json({ success: true, data: await prisma.reportBook.update({ where: { id: req.params.id }, data: { name } }) });
    } catch (err) { next(err); }
  },

  async addSheet(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const last = await prisma.reportSheet.findFirst({ where: { bookId: req.params.id }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
      const count = await prisma.reportSheet.count({ where: { bookId: req.params.id } });
      const name = String(req.body.name || '').trim() || `Sheet${count + 1}`;
      const sheet = await prisma.reportSheet.create({ data: { bookId: req.params.id, name, sortOrder: (last?.sortOrder ?? -1) + 1, content: blank() as object } });
      res.status(201).json({ success: true, data: sheet });
    } catch (err) { next(err); }
  },

  async renameSheet(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) throw new AppError('Give the sheet a name', 400);
      res.json({ success: true, data: await prisma.reportSheet.update({ where: { id: req.params.id }, data: { name } }) });
    } catch (err) { next(err); }
  },

  async deleteSheet(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const sheet = await prisma.reportSheet.findUnique({ where: { id: req.params.id }, select: { bookId: true } });
      if (!sheet) throw new AppError('Sheet not found', 404);
      if ((await prisma.reportSheet.count({ where: { bookId: sheet.bookId } })) <= 1) throw new AppError('A spreadsheet needs at least one sheet', 400);
      await prisma.reportSheet.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * Save edits as small changes: { cells: [{ r, c, cell | null }], rows?, cols?, colWidths?: {c: width} }.
   * Values are stored exactly as typed — nothing is calculated.
   */
  async saveCells(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const sheet = await prisma.reportSheet.findUnique({ where: { id: req.params.id } });
      if (!sheet) throw new AppError('Sheet not found', 404);
      const content = sheet.content as unknown as SheetContent;
      const changes = Array.isArray(req.body.cells) ? (req.body.cells as { r: number; c: number; cell: Cell | null }[]) : [];
      if (changes.length > 5000) throw new AppError('Too many changes at once', 400);
      for (const ch of changes) {
        if (!Number.isInteger(ch.r) || !Number.isInteger(ch.c) || ch.r < 0 || ch.c < 0 || ch.r > 20000 || ch.c > 500) continue;
        const key = `${ch.r},${ch.c}`;
        if (ch.cell === null || (ch.cell && !ch.cell.v && !ch.cell.bg && !ch.cell.fg && !ch.cell.b && !ch.cell.i)) delete content.cells[key];
        else if (ch.cell) {
          const { v, bg, fg, b, i, al } = ch.cell;
          content.cells[key] = { v: String(v ?? '').slice(0, 5000), ...(bg ? { bg: String(bg).slice(0, 20) } : {}), ...(fg ? { fg: String(fg).slice(0, 20) } : {}), ...(b ? { b: 1 as const } : {}), ...(i ? { i: 1 as const } : {}), ...(al ? { al } : {}) };
        }
        if (ch.r >= content.rows) content.rows = ch.r + 20;
        if (ch.c >= content.cols) { content.cols = ch.c + 3; while (content.colWidths.length < content.cols) content.colWidths.push(110); }
      }
      if (Number.isInteger(req.body.rows) && req.body.rows > content.rows && req.body.rows <= 20000) content.rows = req.body.rows;
      if (req.body.colWidths && typeof req.body.colWidths === 'object') {
        for (const [c, w] of Object.entries(req.body.colWidths as Record<string, number>)) {
          const idx = Number(c), width = Math.max(30, Math.min(800, Number(w)));
          if (Number.isInteger(idx) && idx >= 0 && idx < content.colWidths.length && Number.isFinite(width)) content.colWidths[idx] = width;
        }
      }
      await prisma.reportSheet.update({ where: { id: sheet.id }, data: { content: content as object, updatedById: req.user?.employeeId || null } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Live report data. */
  async live(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const q = req.query as { from?: string; to?: string };
      const fn: Record<string, () => Promise<unknown>> = {
        BOOKING: () => booking(q), BOOKED_VS_CONDUCTED: () => bookedVsConducted(q), TODAY_DEMO: () => todayDemo(q),
        BOOKING_RESPONSE: () => bookingResponse(q), DEMO_RESPONSE: () => demoResponse(q), STUDENT_RESPONSE: () => studentResponse(q),
        REV_APPROVAL: () => approval(q), REV_PAYMENT_DETAILS: () => paymentDetails(q), REV_LOAN: () => loan(q), REV_JODO: () => jodo(q),
      };
      const run = fn[req.params.key];
      if (!run) throw new AppError('Unknown report', 404);
      res.json({ success: true, data: await run() });
    } catch (err) { next(err); }
  },

  async setTarget(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId, bookingTarget, demoTarget } = req.body || {};
      if (!employeeId) throw new AppError('Employee is required', 400);
      await saveTarget(String(employeeId), bookingTarget !== undefined ? Number(bookingTarget) : undefined, demoTarget !== undefined ? Number(demoTarget) : undefined);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async editDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try { await editDemoFields(req.params.id, req.body || {}); res.json({ success: true }); } catch (err) { next(err); }
  },

  async editLoan(req: AuthRequest, res: Response, next: NextFunction) {
    try { res.json({ success: true, data: await editLoan(req.params.id, req.body || {}) }); } catch (err) { next(err); }
  },

  async addLoan(req: AuthRequest, res: Response, next: NextFunction) {
    try { res.status(201).json({ success: true, data: await addLoan(req.body || {}, req.user?.employeeId) }); } catch (err) { next(err); }
  },

  async verifyLoan(req: AuthRequest, res: Response, next: NextFunction) {
    try { res.json({ success: true, data: await verifyLoan(req.params.id, req.body?.verified !== false, req.user?.employeeId) }); } catch (err) { next(err); }
  },

  async deleteLoan(req: AuthRequest, res: Response, next: NextFunction) {
    try { await prisma.loanEntry.delete({ where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { next(err); }
  },

  async importJodo(req: AuthRequest, res: Response, next: NextFunction) {
    try { res.json({ success: true, data: await importJodo(req.body?.rows, req.user?.employeeId) }); } catch (err) { next(err); }
  },
};
