-- Leads whose activity was logged without a linked call showed "Last contact: Never". Fill them from their latest logged activity.
UPDATE `Lead` l
JOIN (SELECT `leadId`, MAX(`createdAt`) AS lastAt FROM `LeadHistory` WHERE `type` = 'ACTIVITY' GROUP BY `leadId`) h ON h.`leadId` = l.`id`
SET l.`lastContactAt` = h.lastAt
WHERE l.`lastContactAt` IS NULL;
