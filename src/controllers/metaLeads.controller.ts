import { Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { config } from '../config/env';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { MAX_ATTEMPTS, checkToken, getMetaConfig, metaReady, processLeadgen, verifySignature } from '../services/metaLeads.service';

/** PUBLIC (no login) — Meta calls these two. */
export const metaWebhookController = {
  /** One-time handshake when you save the callback URL in the Meta developer app. */
  verify(req: Request, res: Response) {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as Record<string, string>;
    if (mode === 'subscribe' && config.META_VERIFY_TOKEN && token === config.META_VERIFY_TOKEN) return res.status(200).send(String(challenge));
    return res.status(403).send('Forbidden');
  },

  /** Lead notifications. Answers 200 straight away (Meta retries slow endpoints) and processes in the background. */
  async receive(req: Request, res: Response) {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined)) return res.status(401).send('Bad signature');
    res.status(200).send('EVENT_RECEIVED');
    try {
      const cfg = await getMetaConfig();
      for (const entry of req.body?.entry || []) {
        for (const ch of entry.changes || []) {
          if (ch.field !== 'leadgen' || !ch.value?.leadgen_id) continue;
          const hint = { formId: ch.value.form_id ? String(ch.value.form_id) : undefined, pageId: ch.value.page_id ? String(ch.value.page_id) : entry.id ? String(entry.id) : undefined };
          if (!cfg.enabled) { await prisma.metaLeadEvent.upsert({ where: { leadgenId: String(ch.value.leadgen_id) }, update: {}, create: { leadgenId: String(ch.value.leadgen_id), ...hint, status: 'FAILED', error: 'Integration is switched off in Sales → Meta Leads — press Retry after switching it on' } }); continue; }
          await processLeadgen(String(ch.value.leadgen_id), hint);
        }
      }
    } catch (e) { console.error('Meta webhook processing failed:', e); }
  },
};

/** Sales Admin — Sales → Meta Leads. */
export const metaLeadsAdminController = {
  async get(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const cfg = await getMetaConfig();
      const [events, counts] = await Promise.all([
        prisma.metaLeadEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
        prisma.metaLeadEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      ]);
      res.json({ success: true, data: { config: cfg, ready: metaReady(), maxAttempts: MAX_ATTEMPTS, counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])), events } });
    } catch (err) { next(err); }
  },

  async save(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const b = req.body || {};
      const mode = ['MY_BASE', 'ROUND_ROBIN', 'FIXED'].includes(b.assignMode) ? b.assignMode : 'MY_BASE';
      const ids: string[] = Array.isArray(b.roundRobinIds) ? b.roundRobinIds.map(String) : [];
      if (mode === 'FIXED' && !b.fixedOwnerId) throw new AppError('Choose the owner for new Meta leads', 400);
      if (mode === 'ROUND_ROBIN' && !ids.length) throw new AppError('Choose at least one salesperson for round-robin', 400);
      await getMetaConfig();
      const saved = await prisma.metaLeadConfig.update({
        where: { id: 'default' },
        data: { enabled: !!b.enabled, assignMode: mode, fixedOwnerId: mode === 'FIXED' ? String(b.fixedOwnerId) : null, roundRobinIds: ids.join(','), defaultCourse: b.defaultCourse ? String(b.defaultCourse).trim() : null, formCourseMap: b.formCourseMap ? String(b.formCourseMap) : null },
      });
      res.json({ success: true, data: saved });
    } catch (err) { next(err); }
  },

  /** Checks the Page token against Meta. */
  async test(_req: AuthRequest, res: Response, next: NextFunction) {
    try { res.json({ success: true, data: { ready: metaReady(), token: await checkToken() } }); } catch (err) { next(err); }
  },

  async retry(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const ev = await prisma.metaLeadEvent.findUnique({ where: { id: req.params.id } });
      if (!ev) throw new AppError('Not found', 404);
      if (ev.status === 'PROCESSED' || ev.status === 'DUPLICATE') throw new AppError('This lead was already handled', 400);
      const out = await processLeadgen(ev.leadgenId, { formId: ev.formId || undefined, pageId: ev.pageId || undefined });
      res.json({ success: true, data: out });
    } catch (err) { next(err); }
  },
};
