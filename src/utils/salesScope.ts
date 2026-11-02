import prisma from '../config/database';

/**
 * Whose leads an employee may see (Sales → Teams mapping).
 *  - Member (no one reports to them): only themselves.
 *  - Team Lead: themselves and everyone who reports to them (at any depth). A member shared by
 *    two TLs shows only that member's leads to both — TLs do not see each other's leads.
 * Sales admins bypass this entirely (handled by the callers).
 */
export async function visibleEmployeeIds(employeeId: string | undefined | null): Promise<string[]> {
  if (!employeeId) return [];
  const links = await prisma.salesTeamMap.findMany({ select: { employeeId: true, tlId: true } });
  const below = (root: string, into: Set<string>) => {
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const l of links) if (l.tlId === cur && !into.has(l.employeeId)) { into.add(l.employeeId); stack.push(l.employeeId); }
    }
  };
  const out = new Set<string>([employeeId]);
  const mine = new Set<string>();
  below(employeeId, mine);
  if (!mine.size) return [employeeId];
  mine.forEach((m) => out.add(m));
  return Array.from(out);
}

export async function isPresales(employeeId: string | undefined | null): Promise<boolean> {
  if (!employeeId) return false;
  return !!(await prisma.salesPresales.findUnique({ where: { employeeId } }));
}
