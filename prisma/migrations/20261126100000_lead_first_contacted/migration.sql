-- First time a lead was contacted (set once). Backfilled from the earliest logged call, else the last contact.
ALTER TABLE `Lead` ADD COLUMN `firstContactedAt` DATETIME(3) NULL;

UPDATE `Lead` l
SET l.`firstContactedAt` = COALESCE(
  (SELECT MIN(c.`calledAt`) FROM `LeadCallLog` c WHERE c.`leadId` = l.`id`),
  l.`lastContactAt`
)
WHERE l.`lastContactAt` IS NOT NULL OR EXISTS (SELECT 1 FROM `LeadCallLog` c2 WHERE c2.`leadId` = l.`id`);

-- Leads that have an owner but no assigned time: use when they were created.
UPDATE `Lead` SET `assignedAt` = `createdAt` WHERE `assignedToId` IS NOT NULL AND `assignedAt` IS NULL;
