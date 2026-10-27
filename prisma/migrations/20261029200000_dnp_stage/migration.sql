-- "DNP" (did not pick up) as a lead stage — sits between Contacted and Demo Scheduled. Editable later in Config → Stages.
INSERT INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`color`,`base`,`active`,`sortOrder`,`updatedAt`)
SELECT UUID(),'STAGE','CUSTOM_DNP','DNP','slate','CONTACTED',true,25,CURRENT_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM `LeadConfigItem` WHERE `kind`='STAGE' AND `key`='CUSTOM_DNP');

-- Logging a DNP now moves the lead to the DNP stage automatically.
UPDATE `LeadConfigItem` SET `targetStageKey`='CUSTOM_DNP' WHERE `kind`='STATUS' AND `key`='DNP';
