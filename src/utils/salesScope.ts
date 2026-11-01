import prisma from '../config/database';

/**
 * Whose leads an employee may see (Sales → Teams mapping).
 *  - Member (no one reports to them): only themselves.
 *  - Team Lead: themselves, everyone who reports to them (at any depth), and their co-TLs —
 *    anyone who shares a member with them — plus those co-TLs' members.
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
  // Co-TLs: other leaders of any of my direct members.
  const direct = links.filter((l) => l.tlId === employeeId).map((l) => l.employeeId);
  const peers = new Set(links.filter((l) => direct.includes(l.employeeId) && l.tlId !== employeeId).map((l) => l.tlId));
  peers.forEach((p) => { out.add(p); const sub = new Set<string>(); below(p, sub); sub.forEach((x) => out.add(x)); });
  return Array.from(out);
}
