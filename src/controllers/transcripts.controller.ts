import { Response, NextFunction } from 'express';
import fs from 'fs';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { CALL_RECORDING_DIR } from '../middleware/upload';
import { enqueueCallTranscript, enqueueDemoTranscript, processPending, transcriptionEnabled } from '../services/transcription.service';
import { config } from '../config/env';

async function isAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN') return true;
  return (await getEffectiveAccess(req.user.userId)).SALES === 'ADMIN';
}

/** Who may see/run a transcript: Sales Admin, or the person who made the call / hosts the demo / owns the lead. */
async function assertSourceAccess(req: AuthRequest, type: string, id: string): Promise<{ leadId: string | null; ownerId: string | null }> {
  const me = req.user?.employeeId || null;
  const admin = await isAdmin(req);
  if (type === 'CALL') {
    const log = await prisma.leadCallLog.findUnique({ where: { id }, select: { leadId: true, calledById: true, lead: { select: { assignedToId: true } } } });
    if (!log) throw new AppError('Call not found', 404);
    if (!admin && me !== log.calledById && me !== log.lead?.assignedToId) throw new AppError('You do not have access to this call', 403);
    return { leadId: log.leadId, ownerId: log.calledById };
  }
  if (type === 'DEMO') {
    const d = await prisma.demo.findUnique({ where: { id }, select: { leadId: true, conductedById: true, lead: { select: { assignedToId: true } } } });
    if (!d) throw new AppError('Demo not found', 404);
    if (!admin && me !== d.conductedById && me !== d.lead.assignedToId) throw new AppError('You do not have access to this demo', 403);
    return { leadId: d.leadId, ownerId: d.conductedById || d.lead.assignedToId };
  }
  throw new AppError('Unknown transcript type', 400);
}

const typeOf = (v: unknown) => String(v || '').toUpperCase();

export const transcriptsController = {
  /** Whether transcription is switched on + queue size (for the UI). */
  async status(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [pending, processing, failed] = await Promise.all([
        prisma.callTranscript.count({ where: { status: 'PENDING' } }),
        prisma.callTranscript.count({ where: { status: 'PROCESSING' } }),
        prisma.callTranscript.count({ where: { status: 'FAILED' } }),
      ]);
      res.json({ success: true, data: { enabled: transcriptionEnabled(), summaries: !!(config.OLLAMA_URL || config.GEMINI_API_KEY), pending, processing, failed } });
    } catch (err) { next(err); }
  },

  /** One call's / demo's transcript (null data when none yet). */
  async getOne(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const type = typeOf(req.params.type);
      await assertSourceAccess(req, type, req.params.id);
      const t = await prisma.callTranscript.findUnique({ where: { sourceType_sourceId: { sourceType: type, sourceId: req.params.id } } });
      let hasAudio = false;
      if (type === 'CALL') hasAudio = fs.existsSync(CALL_RECORDING_DIR) && fs.readdirSync(CALL_RECORDING_DIR).some((f) => f.startsWith(`${req.params.id}.`));
      else hasAudio = !!(await prisma.demo.findUnique({ where: { id: req.params.id }, select: { audioKey: true } }))?.audioKey;
      res.json({ success: true, data: t, meta: { enabled: transcriptionEnabled(), hasAudio } });
    } catch (err) { next(err); }
  },

  /** Queue (or re-queue) a transcription. */
  async run(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const type = typeOf(req.params.type);
      await assertSourceAccess(req, type, req.params.id);
      if (!transcriptionEnabled()) throw new AppError('Transcription is not switched on yet. Ask an admin to set WHISPER_URL on the server.', 503);
      const row = type === 'CALL' ? await enqueueCallTranscript(req.params.id, true) : await enqueueDemoTranscript(req.params.id, true);
      if (!row) throw new AppError('There is no recording to transcribe for this item yet.', 400);
      processPending(1).catch(() => {}); // start straight away instead of waiting for the next minute tick
      res.status(202).json({ success: true, data: row });
    } catch (err) { next(err); }
  },

  /** Search / list. Sales Admin sees all; everyone else only their own calls and demos. */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const q = String(req.query.q || '').trim();
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
      const limit = 25;
      const where: Record<string, unknown> = { status: 'DONE' };
      if (!admin) where.ownerId = req.user?.employeeId || '__none__';
      else if (req.query.ownerId) where.ownerId = String(req.query.ownerId);
      if (req.query.type) where.sourceType = typeOf(req.query.type);
      if (req.query.leadId) where.leadId = String(req.query.leadId);
      if (req.query.from || req.query.to) {
        where.createdAt = {
          ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
          ...(req.query.to ? { lte: new Date(`${String(req.query.to)}T23:59:59.999Z`) } : {}),
        };
      }
      if (q) where.OR = [{ text: { contains: q } }, { summary: { contains: q } }];
      const [rows, total] = await Promise.all([
        prisma.callTranscript.findMany({ where: where as never, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
        prisma.callTranscript.count({ where: where as never }),
      ]);
      const leadIds = Array.from(new Set(rows.map((r) => r.leadId).filter(Boolean))) as string[];
      const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId).filter(Boolean))) as string[];
      const [leads, owners] = await Promise.all([
        prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true, phone: true } }),
        prisma.employee.findMany({ where: { id: { in: ownerIds } }, select: { id: true, firstName: true, lastName: true } }),
      ]);
      const leadMap = new Map(leads.map((l) => [l.id, l]));
      const ownerMap = new Map(owners.map((o) => [o.id, `${o.firstName} ${o.lastName}`]));
      const snippet = (text: string | null) => {
        if (!text) return '';
        if (!q) return text.slice(0, 220);
        const i = text.toLowerCase().indexOf(q.toLowerCase());
        if (i < 0) return text.slice(0, 220);
        return `${i > 80 ? '…' : ''}${text.slice(Math.max(0, i - 80), i + q.length + 140)}…`;
      };
      res.json({
        success: true,
        data: rows.map((r) => ({
          id: r.id, sourceType: r.sourceType, sourceId: r.sourceId, createdAt: r.createdAt, durationSec: r.durationSec, language: r.language,
          summary: r.summary, topics: r.topics, snippet: snippet(r.text),
          lead: r.leadId ? leadMap.get(r.leadId) || null : null, owner: r.ownerId ? ownerMap.get(r.ownerId) || null : null,
        })),
        meta: { total, page, limit, pages: Math.ceil(total / limit) },
      });
    } catch (err) { next(err); }
  },
};
