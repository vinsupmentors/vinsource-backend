-- "Demo Over" is split in two stages the sales team picks themselves; the plain Demo Over stage and status are switched off.
INSERT INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`color`,`base`,`active`,`sortOrder`,`updatedAt`)
SELECT UUID(), 'STAGE', v.k, v.l, v.c, 'DEMO_DONE', true, v.s, CURRENT_TIMESTAMP(3)
FROM (
  SELECT 'CUSTOM_DEMO_OVER_POSITIVE' AS k, 'Demo Over - Positive' AS l, 'green' AS c, 50 AS s
  UNION ALL SELECT 'CUSTOM_DEMO_OVER_FOLLOW_UP', 'Demo Over - Need Follow up', 'purple', 55
) v
WHERE NOT EXISTS (SELECT 1 FROM `LeadConfigItem` c WHERE c.`kind`='STAGE' AND c.`key`=v.k);

UPDATE `LeadConfigItem` SET `active`=false WHERE `kind`='STAGE' AND `key`='DEMO_DONE';
UPDATE `LeadConfigItem` SET `active`=false WHERE `kind`='STATUS' AND `key`='DEMO_OVER';

-- Leads sitting on the old Demo Over stage need a follow-up.
UPDATE `Lead` SET `stageKey`='CUSTOM_DEMO_OVER_FOLLOW_UP' WHERE `status`='DEMO_DONE' AND `stageKey` IS NULL;
