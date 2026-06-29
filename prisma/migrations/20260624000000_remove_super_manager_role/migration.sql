-- Remove the SUPER_MANAGER role tier.
-- Org decision: there is a single Owner (Pooranam Annamalai) who gets full access,
-- everyone else below that is a plain MANAGER. SUPER_MANAGER is retired.

-- 1) Reassign existing rows BEFORE narrowing the enum, otherwise MySQL will reject
--    or silently blank out any row still holding the value being dropped.

-- Pooranam Annamalai -> SUPER_ADMIN (the new top/owner tier)
UPDATE `User` u
JOIN `Employee` e ON e.`userId` = u.`id`
SET u.`role` = 'SUPER_ADMIN'
WHERE u.`role` = 'SUPER_MANAGER'
  AND e.`firstName` = 'Pooranam'
  AND e.`lastName` = 'Annamalai';

-- Everyone else still on SUPER_MANAGER -> MANAGER
UPDATE `User`
SET `role` = 'MANAGER'
WHERE `role` = 'SUPER_MANAGER';

-- 2) Narrow the enum now that no row references SUPER_MANAGER.
ALTER TABLE `User`
  MODIFY `role` ENUM('SUPER_ADMIN', 'ADMIN', 'HR', 'MANAGER', 'EMPLOYEE') NOT NULL DEFAULT 'EMPLOYEE';
