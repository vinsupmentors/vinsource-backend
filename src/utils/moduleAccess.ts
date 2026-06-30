import prisma from '../config/database';
import { ModuleName, AccessLevel } from '@prisma/client';

export type EffectiveAccessMap = Partial<Record<ModuleName, AccessLevel>>;

/**
 * Computes a user's effective module access:
 *   1. Start with their department's default module mapping (DepartmentModuleAccess).
 *   2. Apply any per-user overrides (UserModuleAccess) on top — these win.
 *      An override of AccessLevel.NONE explicitly revokes a module even if
 *      the department would otherwise grant it.
 *
 * Management-tier users without an explicit department mapping fall back to
 * whatever the seed/admin has configured for their department — there is no
 * implicit "sees everything" rule beyond what DepartmentModuleAccess defines,
 * so cross-module visibility for Management is data-driven, not hardcoded.
 */
export async function getEffectiveAccess(userId: string): Promise<EffectiveAccessMap> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      employee: {
        include: {
          department: { include: { moduleAccessDefaults: true } },
        },
      },
      moduleAccessGrants: true,
    },
  });

  if (!user) return {};

  // SUPER_ADMIN always gets full ADMIN access to every module.
  if (user.role === 'SUPER_ADMIN') {
    return Object.fromEntries(
      Object.values(ModuleName).map((m) => [m, AccessLevel.ADMIN])
    ) as EffectiveAccessMap;
  }

  const access: EffectiveAccessMap = {};

  for (const dma of user.employee?.department?.moduleAccessDefaults ?? []) {
    access[dma.module] = dma.accessLevel;
  }

  for (const override of user.moduleAccessGrants) {
    if (override.accessLevel === AccessLevel.NONE) {
      delete access[override.module];
    } else {
      access[override.module] = override.accessLevel;
    }
  }

  return access;
}

/** List of modules the user can see at all (any access level above NONE). */
export async function getVisibleModules(userId: string): Promise<ModuleName[]> {
  const access = await getEffectiveAccess(userId);
  return Object.keys(access) as ModuleName[];
}
