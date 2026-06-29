-- One-time fix: reassign any leftover SUPER_MANAGER rows before db push narrows the enum.
-- Same logic as prisma/migrations/20260624000000_remove_super_manager_role/migration.sql,
-- which exists in the migrations folder but was never actually applied to this database.

UPDATE `User` u
JOIN `Employee` e ON e.`userId` = u.`id`
SET u.`role` = 'SUPER_ADMIN'
WHERE u.`role` = 'SUPER_MANAGER'
  AND e.`firstName` = 'Pooranam'
  AND e.`lastName` = 'Annamalai';

UPDATE `User`
SET `role` = 'MANAGER'
WHERE `role` = 'SUPER_MANAGER';
