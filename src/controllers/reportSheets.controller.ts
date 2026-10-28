import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { BRD_TRACKER_SHEETS, SheetContent, Cell } from '../utils/reportSheetsSeed';

const blank = (): SheetContent => ({ rows: 40, cols: 12, colWidths: Array(12).fill(110), rowHeights: {}, merges: [], cells: {}, frozenRows: 0 });

/** First visit: create the "BRD Tracker" spreadsheet with its five sheets. */
async function ensureSeed() {
  if ((await prisma.reportBook.count()) > 0) return;
  await prisma.reportBook.create({
    data: {
      name: 'BRD Tracker',
      sheets: { create: BRD_TRACKER_SHEETS.map((s, i) => ({ name: s.name, sortOrder: i, content: s.content as object })) },
    },
  });
}

export const reportSheetsController = {
  async listBooks(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await ensureSeed();
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
};
