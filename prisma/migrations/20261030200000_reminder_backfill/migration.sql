-- Open leads must always have a next reminder.

-- 1) A lead with an upcoming booked demo is reminded at the demo slot.
UPDATE `Lead` l
JOIN (SELECT `leadId`, MIN(`scheduledAt`) AS at FROM `Demo` WHERE `status` = 'SCHEDULED' AND `scheduledAt` >= NOW() GROUP BY `leadId`) d ON d.`leadId` = l.`id`
SET l.`nextFollowUpAt` = d.at
WHERE l.`deletedAt` IS NULL AND l.`nextFollowUpAt` IS NULL AND l.`status` NOT IN ('LOST','ENROLLED');

-- 2) Leads sitting in a follow-up stage with no date get tomorrow 11:00 IST (05:30 UTC).
UPDATE `Lead`
SET `nextFollowUpAt` = TIMESTAMP(DATE_ADD(UTC_DATE(), INTERVAL 1 DAY), '05:30:00')
WHERE `deletedAt` IS NULL AND `nextFollowUpAt` IS NULL AND `status` NOT IN ('LOST','ENROLLED')
  AND `stageKey` IN ('CUSTOM_FOLLOW_UP','CUSTOM_DEMO_OVER_FOLLOW_UP');

-- 3) Every open lead reminder is also a task in My Reminders / Manage Tasks (demo-slot reminders already have their demo task).
INSERT INTO `SalesTask` (`id`,`title`,`leadId`,`assignedToId`,`dueAt`,`status`,`kind`,`createdAt`,`updatedAt`)
SELECT UUID(), CONCAT('Follow up with ', l.`name`), l.`id`, l.`assignedToId`, l.`nextFollowUpAt`, 'OPEN', 'FOLLOW_UP', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Lead` l
WHERE l.`deletedAt` IS NULL AND l.`assignedToId` IS NOT NULL AND l.`nextFollowUpAt` IS NOT NULL AND l.`status` NOT IN ('LOST','ENROLLED')
  AND NOT EXISTS (SELECT 1 FROM `SalesTask` t WHERE t.`leadId` = l.`id` AND t.`status` = 'OPEN' AND t.`kind` IN ('FOLLOW_UP','DEMO'));
