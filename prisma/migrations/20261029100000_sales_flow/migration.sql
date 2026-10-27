-- Follow-ups and demos become tasks; demo reminders
ALTER TABLE `SalesTask`
  ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN `demoId` VARCHAR(191) NULL;
CREATE INDEX `SalesTask_demoId_idx` ON `SalesTask`(`demoId`);

ALTER TABLE `Demo` ADD COLUMN `reminderSentAt` DATETIME(3) NULL;
-- Demos already in the past (or starting within the next 10 minutes) must not trigger a reminder after deploy
UPDATE `Demo` SET `reminderSentAt` = CURRENT_TIMESTAMP(3) WHERE `scheduledAt` <= DATE_ADD(NOW(), INTERVAL 10 MINUTE);

-- Backfill: every open lead follow-up becomes a task
INSERT INTO `SalesTask` (`id`,`title`,`leadId`,`assignedToId`,`dueAt`,`status`,`kind`,`createdAt`,`updatedAt`)
SELECT UUID(), CONCAT('Follow up with ', l.`name`), l.`id`, l.`assignedToId`, l.`nextFollowUpAt`, 'OPEN', 'FOLLOW_UP', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Lead` l
WHERE l.`deletedAt` IS NULL AND l.`assignedToId` IS NOT NULL AND l.`nextFollowUpAt` IS NOT NULL AND l.`status` NOT IN ('LOST','ENROLLED');

-- Backfill: every upcoming scheduled demo becomes a task
INSERT INTO `SalesTask` (`id`,`title`,`leadId`,`assignedToId`,`dueAt`,`status`,`kind`,`demoId`,`createdAt`,`updatedAt`)
SELECT UUID(), CONCAT('Demo with ', l.`name`, IF(d.`courseEnquired` IS NULL, '', CONCAT(' — ', d.`courseEnquired`))), d.`leadId`, COALESCE(d.`conductedById`, l.`assignedToId`), d.`scheduledAt`, 'OPEN', 'DEMO', d.`id`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Demo` d JOIN `Lead` l ON l.`id` = d.`leadId`
WHERE d.`status` = 'SCHEDULED' AND COALESCE(d.`conductedById`, l.`assignedToId`) IS NOT NULL AND l.`deletedAt` IS NULL;
