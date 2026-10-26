import { AppError } from '../middleware/errorHandler';

/**
 * Advanced filter ("LeadSquared-style"): a tree of groups, each group joined by
 * AND or OR, whose leaves are `field operator value` conditions.
 *
 *   { logic: 'AND', children: [
 *       { field: 'source', op: 'in', value: ['Instagram', 'Referral'] },
 *       { logic: 'OR', children: [ {field:'status', op:'is', value:'CONTACTED'}, {field:'city', op:'contains', value:'chen'} ] },
 *   ] }
 *
 * The client only ever names fields from a server-side whitelist (FieldSpec
 * maps), so nothing the user types can reach the query as a column/path.
 */

export type FieldType = 'text' | 'select' | 'date' | 'number';
export interface FieldSpec {
  type: FieldType;
  /** Prisma path to the column, e.g. ['lead', 'name'] → { lead: { name: … } }. */
  path: string[];
  /** Wrap the finished fragment, for to-many relations: (f) => ({ demos: { some: f } }). */
  wrap?: (frag: Record<string, unknown>) => Record<string, unknown>;
  /** Column can be NULL — negations then also keep the NULL rows. */
  nullable?: boolean;
  /** Allowed values for select fields that are enums (guards against bad enum values reaching Prisma). */
  enumValues?: string[];
}
export type FieldMap = Record<string, FieldSpec>;

interface Condition { field: string; op: string; value?: unknown }
interface Group { logic: 'AND' | 'OR'; children: (Condition | Group)[] }

const MAX_DEPTH = 4;
const MAX_NODES = 60;

const nest = (path: string[], leaf: unknown): Record<string, unknown> =>
  path.reduceRight<unknown>((acc, key) => ({ [key]: acc }), leaf) as Record<string, unknown>;

const dayStart = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayEnd = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const asDate = (v: unknown): Date => {
  const d = new Date(String(v));
  if (isNaN(d.getTime())) throw new AppError('Invalid date in filter', 400);
  return d;
};
const asArray = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);

function leafFor(spec: FieldSpec, cond: Condition): Record<string, unknown> {
  const { op, value } = cond;
  const put = (leaf: unknown) => nest(spec.path, leaf);
  const negate = (frag: Record<string, unknown>) => {
    const inner = spec.wrap ? spec.wrap(frag) : frag;
    return spec.nullable && !spec.wrap
      ? { OR: [{ NOT: inner }, put(null)] }
      : { NOT: inner };
  };
  const wrapped = (frag: Record<string, unknown>) => (spec.wrap ? spec.wrap(frag) : frag);

  if (op === 'empty' || op === 'not_empty') {
    // A required column can never be NULL, so only an empty string can count as "empty" there.
    if (!spec.nullable) {
      if (spec.type !== 'text') throw new AppError('"Is empty" does not apply to this field', 400);
      return wrapped(op === 'empty' ? put('') : { NOT: put('') });
    }
    if (op === 'empty') return wrapped(spec.type === 'text' ? { OR: [put(null), put('')] } : put(null));
    return wrapped(spec.type === 'text' ? { AND: [{ NOT: put(null) }, { NOT: put('') }] } : { NOT: put(null) });
  }

  switch (spec.type) {
    case 'text': {
      const v = String(value ?? '');
      if (!v) throw new AppError('Enter a value for the filter', 400);
      switch (op) {
        case 'is': return wrapped(put({ equals: v }));
        case 'is_not': return negate(put({ equals: v }));
        case 'contains': return wrapped(put({ contains: v }));
        case 'not_contains': return negate(put({ contains: v }));
        case 'starts': return wrapped(put({ startsWith: v }));
        case 'ends': return wrapped(put({ endsWith: v }));
      }
      break;
    }
    case 'select': {
      const vals = asArray(value);
      if (!vals.length) throw new AppError('Choose a value for the filter', 400);
      if (spec.enumValues && vals.some((x) => !spec.enumValues!.includes(x))) throw new AppError('Invalid option in filter', 400);
      switch (op) {
        case 'is': return wrapped(put({ equals: vals[0] }));
        case 'is_not': return negate(put({ equals: vals[0] }));
        case 'in': return wrapped(put({ in: vals }));
        case 'not_in': return negate(put({ in: vals }));
      }
      break;
    }
    case 'number': {
      const n = Number(Array.isArray(value) ? value[0] : value);
      if (!Number.isFinite(n)) throw new AppError('Enter a number for the filter', 400);
      switch (op) {
        case 'eq': return wrapped(put({ equals: n }));
        case 'neq': return negate(put({ equals: n }));
        case 'gt': return wrapped(put({ gt: n }));
        case 'lt': return wrapped(put({ lt: n }));
        case 'between': {
          const arr = Array.isArray(value) ? value : [];
          const a = Number(arr[0]), b = Number(arr[1]);
          if (!Number.isFinite(a) || !Number.isFinite(b)) throw new AppError('Enter both numbers for "between"', 400);
          return wrapped(put({ gte: Math.min(a, b), lte: Math.max(a, b) }));
        }
      }
      break;
    }
    case 'date': {
      const now = new Date();
      switch (op) {
        case 'today': return wrapped(put({ gte: dayStart(now), lte: dayEnd(now) }));
        case 'yesterday': { const y = new Date(now); y.setDate(y.getDate() - 1); return wrapped(put({ gte: dayStart(y), lte: dayEnd(y) })); }
        case 'last_7': { const s = new Date(now); s.setDate(s.getDate() - 6); return wrapped(put({ gte: dayStart(s), lte: dayEnd(now) })); }
        case 'last_30': { const s = new Date(now); s.setDate(s.getDate() - 29); return wrapped(put({ gte: dayStart(s), lte: dayEnd(now) })); }
        case 'this_month': return wrapped(put({ gte: new Date(now.getFullYear(), now.getMonth(), 1), lte: dayEnd(now) }));
        case 'overdue': return wrapped(put({ lt: dayStart(now) }));
        case 'on': { const d = asDate(value); return wrapped(put({ gte: dayStart(d), lte: dayEnd(d) })); }
        case 'before': return wrapped(put({ lt: dayStart(asDate(value)) }));
        case 'after': return wrapped(put({ gt: dayEnd(asDate(value)) }));
        case 'between': {
          const arr = Array.isArray(value) ? value : [];
          if (!arr[0] || !arr[1]) throw new AppError('Pick both dates for "between"', 400);
          return wrapped(put({ gte: dayStart(asDate(arr[0])), lte: dayEnd(asDate(arr[1])) }));
        }
      }
      break;
    }
  }
  throw new AppError(`Unsupported filter operator "${op}"`, 400);
}

function walk(node: Condition | Group, fields: FieldMap, depth: number, counter: { n: number }): Record<string, unknown> | null {
  if (++counter.n > MAX_NODES) throw new AppError('Filter is too large', 400);
  if (depth > MAX_DEPTH) throw new AppError('Filter groups are nested too deeply', 400);
  if ('children' in node) {
    const parts = node.children.map((c) => walk(c, fields, depth + 1, counter)).filter(Boolean) as Record<string, unknown>[];
    if (!parts.length) return null;
    return node.logic === 'OR' ? { OR: parts } : { AND: parts };
  }
  const spec = fields[node.field];
  if (!spec) throw new AppError(`Unknown filter field "${node.field}"`, 400);
  return leafFor(spec, node);
}

/** Parse the `filter` query/body value (JSON string or object) into a Prisma `where` fragment, or null when empty. */
export function buildWhereFromFilter(raw: unknown, fields: FieldMap): Record<string, unknown> | null {
  if (!raw) return null;
  let tree: unknown = raw;
  if (typeof raw === 'string') {
    try { tree = JSON.parse(raw); } catch { throw new AppError('Filter could not be read', 400); }
  }
  if (!tree || typeof tree !== 'object') return null;
  return walk(tree as Group, fields, 0, { n: 0 });
}
