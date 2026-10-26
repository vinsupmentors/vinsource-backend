import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { clearLeadConfigCache, ConfigKind, leadConfig, loadConfigItems, slugKey } from '../utils/leadConfig';

const KINDS: ConfigKind[] = ['STAGE', 'STATUS', 'LOST_REASON', 'SOURCE', 'SCOUT'];
const COLORS = ['slate', 'blue', 'green', 'amber', 'orange', 'red', 'purple', 'pink', 'teal'];
// Stages that the pipeline itself depends on — they can be renamed but never switched off.
const LOCKED_STAGES = ['NEW', 'ENROLLED', 'LOST'];
const BASE_STAGES = ['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'DEMO_DONE', 'NEGOTIATION', 'ENROLLED', 'LOST'];
const BASE_STATUSES = ['DNP', 'FOLLOW_UP', 'DEMO_BOOKED', 'DEMO_OVER', 'NOT_INTERESTED', 'DISQUALIFIED'];
const BASE_REASONS = ['NOT_INTERESTED', 'INVALID_NUMBER', 'UNREACHABLE', 'DUPLICATE', 'OTHER'];

const kindOf = (v: unknown): ConfigKind => {
  const k = String(v || '').toUpperCase().replace(/-/g, '_') as ConfigKind;
  if (!KINDS.includes(k)) throw new AppError('Unknown config list', 400);
  return k;
};

/** How many leads use an item (decides whether it can be deleted or only switched off). */
async function usage(kind: ConfigKind, key: string, label: string): Promise<number> {
  switch (kind) {
    case 'STAGE': return prisma.lead.count({ where: { OR: [{ stageKey: key }, { status: key as never, stageKey: null }] } });
    case 'STATUS': return (await prisma.lead.count({ where: { statusKey: key } })) + (await prisma.leadCallLog.count({ where: { statusKey: key } }));
    case 'LOST_REASON': return prisma.lead.count({ where: { lostReasonKey: key } });
    case 'SOURCE': return prisma.lead.count({ where: { source: label } });
    case 'SCOUT': return prisma.lead.count({ where: { scoutKey: key } });
  }
}

export const leadConfigController = {
  /** Everything the Sales screens need to render dropdowns, chips and filters. Salespeople get active items only. */
  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const all = req.query.all === '1';
      const items = await loadConfigItems(true);
      const pick = (kind: ConfigKind) => items.filter((i) => i.kind === kind && (all || i.active));
      res.json({ success: true, data: { stages: pick('STAGE'), statuses: pick('STATUS'), lostReasons: pick('LOST_REASON'), sources: pick('SOURCE'), scouts: pick('SCOUT'), colors: COLORS } });
    } catch (err) { next(err); }
  },

  /** Create (POST /config/:kind) or update (PUT /config/:kind/:id) one item. */
  async save(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const kind = kindOf(req.params.kind);
      const b = req.body || {};
      const label = String(b.label || '').trim();
      if (!label) throw new AppError('Give it a name', 400);
      const cfg = await leadConfig();
      const existing = req.params.id ? await prisma.leadConfigItem.findUnique({ where: { id: req.params.id } }) : null;
      if (req.params.id && (!existing || existing.kind !== kind)) throw new AppError('Item not found', 404);

      const data: Record<string, unknown> = { label, active: b.active !== false };
      if (b.sortOrder !== undefined && Number.isFinite(Number(b.sortOrder))) data.sortOrder = Math.round(Number(b.sortOrder));
      if (b.color !== undefined) data.color = COLORS.includes(String(b.color)) ? String(b.color) : null;

      if (kind === 'STAGE') {
        const base = String(b.base || existing?.base || '');
        if (!BASE_STAGES.includes(base)) throw new AppError('Choose which built-in stage this one counts as in reports', 400);
        data.base = existing?.system ? existing.base : base;
        if (existing?.system && LOCKED_STAGES.includes(existing.key)) data.active = true;
      }
      if (kind === 'STATUS') {
        const base = String(b.base || existing?.base || '');
        if (!BASE_STATUSES.includes(base)) throw new AppError('Choose which built-in status this one behaves like', 400);
        const target = String(b.targetStageKey || existing?.targetStageKey || '');
        const stage = cfg.find('STAGE', target);
        if (!stage) throw new AppError('Choose the stage this status moves the lead to', 400);
        data.base = existing?.system ? existing.base : base;
        data.targetStageKey = target;
        data.needsFollowUp = b.needsFollowUp === true;
        data.notesRequired = b.notesRequired !== false;
      }
      if (kind === 'LOST_REASON') {
        const base = String(b.base || existing?.base || 'OTHER');
        if (!BASE_REASONS.includes(base)) throw new AppError('Choose which built-in reason this one counts as', 400);
        data.base = existing?.system ? existing.base : base;
      }

      // Duplicate-name guard within the list.
      const clash = cfg.items.find((i) => i.kind === kind && i.label.toLowerCase() === label.toLowerCase() && i.id !== existing?.id);
      if (clash) throw new AppError(`"${clash.label}" already exists in this list`, 409);

      let row;
      if (existing) {
        row = await prisma.leadConfigItem.update({ where: { id: existing.id }, data });
        // Renaming a source rewrites it on existing leads so reports and filters stay consistent.
        if (kind === 'SOURCE' && existing.label !== label) {
          await prisma.lead.updateMany({ where: { source: existing.label }, data: { source: label } });
          await prisma.leadConfigItem.update({ where: { id: existing.id }, data: { key: label } });
        }
      } else {
        let key = kind === 'SOURCE' ? label : slugKey(label);
        if (kind === 'SCOUT') key = `SCOUT_${slugKey(label)}`;
        else if (kind !== 'SOURCE') key = `CUSTOM_${slugKey(label)}`;
        if (!key || key.endsWith('_')) throw new AppError('Use letters or numbers in the name', 400);
        if (cfg.items.some((i) => i.kind === kind && i.key.toLowerCase() === key.toLowerCase())) key = `${key}_${Date.now().toString(36).slice(-4)}`;
        const max = Math.max(0, ...cfg.of(kind).map((i) => i.sortOrder));
        row = await prisma.leadConfigItem.create({ data: { kind, key, system: false, sortOrder: max + 10, ...data } as never });
      }
      clearLeadConfigCache();
      res.status(existing ? 200 : 201).json({ success: true, data: row });
    } catch (err) { next(err); }
  },

  /** Delete an unused custom item; anything in use (or built-in) can only be switched off. */
  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const kind = kindOf(req.params.kind);
      const item = await prisma.leadConfigItem.findUnique({ where: { id: req.params.id } });
      if (!item || item.kind !== kind) throw new AppError('Item not found', 404);
      if (item.system) throw new AppError('Built-in items cannot be deleted — switch them off instead', 400);
      const used = await usage(kind, item.key, item.label);
      if (used > 0) throw new AppError(`${used} record${used === 1 ? '' : 's'} use "${item.label}". Switch it off instead of deleting.`, 409);
      if (kind === 'STAGE') {
        const refs = await prisma.leadConfigItem.count({ where: { kind: 'STATUS', targetStageKey: item.key } });
        if (refs) throw new AppError(`${refs} update status${refs === 1 ? '' : 'es'} move leads to this stage. Change those first.`, 409);
      }
      await prisma.leadConfigItem.delete({ where: { id: item.id } });
      clearLeadConfigCache();
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
