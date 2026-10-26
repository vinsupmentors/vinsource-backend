import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

/**
 * Config-driven stages / update statuses / lost reasons / sources / scouts.
 * Custom items always carry a BASE (one of the built-in enum values) so every
 * report and rule keeps working: Lead.status / activityStatus / lostReason hold
 * the base, and Lead.stageKey / statusKey / lostReasonKey hold the custom key.
 */

export type ConfigKind = 'STAGE' | 'STATUS' | 'LOST_REASON' | 'SOURCE' | 'SCOUT';
export interface ConfigItem {
  id: string; kind: string; key: string; label: string; color: string | null; base: string | null; targetStageKey: string | null;
  needsFollowUp: boolean; notesRequired: boolean; active: boolean; system: boolean; sortOrder: number;
}

const TTL_MS = 15000;
let cache: { at: number; items: ConfigItem[] } | null = null;

export function clearLeadConfigCache() { cache = null; }

export async function loadConfigItems(force = false): Promise<ConfigItem[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.items;
  const items = (await prisma.leadConfigItem.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] })) as ConfigItem[];
  cache = { at: Date.now(), items };
  return items;
}

export async function leadConfig() {
  const items = await loadConfigItems();
  const of = (kind: ConfigKind) => items.filter((i) => i.kind === kind);
  const find = (kind: ConfigKind, key: string | null | undefined) => (key ? items.find((i) => i.kind === kind && i.key === key) : undefined);
  const label = (kind: ConfigKind, key: string | null | undefined, fallback = '') => find(kind, key)?.label || fallback || (key || '').replace(/_/g, ' ');
  return { items, of, find, label };
}

/** A stage key from the UI → what to store on the lead. */
export async function resolveStage(key: string): Promise<{ status: string; stageKey: string | null; label: string }> {
  const cfg = await leadConfig();
  const def = cfg.find('STAGE', key);
  if (!def || !def.base) throw new AppError(`Unknown lead stage "${key}"`, 400);
  if (!def.active && !def.system) throw new AppError(`The stage "${def.label}" is switched off`, 400);
  return { status: def.base, stageKey: def.system ? null : def.key, label: def.label };
}

/** A lost-reason key from the UI → base enum + custom key. */
export async function resolveLostReason(key: string): Promise<{ lostReason: string; lostReasonKey: string | null; label: string }> {
  const cfg = await leadConfig();
  const def = cfg.find('LOST_REASON', key);
  if (!def || !def.base) throw new AppError(`Unknown lost reason "${key}"`, 400);
  return { lostReason: def.base, lostReasonKey: def.system ? null : def.key, label: def.label };
}

/** The label to show for a lead's current stage / status. */
export async function stageLabelFor(lead: { status: string; stageKey?: string | null }) {
  const cfg = await leadConfig();
  return cfg.label('STAGE', lead.stageKey || lead.status);
}

/** Register a source name in the Config list the first time it is used (so dropdowns stay complete). */
export async function ensureSource(name: string | null | undefined) {
  const s = (name || '').trim();
  if (!s) return;
  const cfg = await leadConfig();
  if (cfg.items.some((i) => i.kind === 'SOURCE' && i.key.toLowerCase() === s.toLowerCase())) return;
  try {
    await prisma.leadConfigItem.create({ data: { kind: 'SOURCE', key: s, label: s, sortOrder: 100 } });
    clearLeadConfigCache();
  } catch { /* created concurrently */ }
}

/** Scout key from a name typed in a bulk-upload sheet (matches label, case-insensitive). */
export async function scoutKeyByName(name: string | null | undefined): Promise<string | null> {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  const cfg = await leadConfig();
  return cfg.of('SCOUT').find((i) => i.label.toLowerCase() === n || i.key.toLowerCase() === n)?.key || null;
}

export const slugKey = (label: string) => label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
