-- New lead-stage list. Built-in stages keep their key (and base status); the rest are custom stages mapped to a base.
-- Old stages that are no longer wanted (Contacted, Negotiation, Lost) are switched off, and existing leads are moved across.

UPDATE `LeadConfigItem` SET `label`='New Lead', `sortOrder`=10 WHERE `kind`='STAGE' AND `key`='NEW';
UPDATE `LeadConfigItem` SET `sortOrder`=20, `color`='slate' WHERE `kind`='STAGE' AND `key`='CUSTOM_DNP';
UPDATE `LeadConfigItem` SET `sortOrder`=40 WHERE `kind`='STAGE' AND `key`='DEMO_SCHEDULED';
UPDATE `LeadConfigItem` SET `label`='Demo Over', `sortOrder`=50 WHERE `kind`='STAGE' AND `key`='DEMO_DONE';
UPDATE `LeadConfigItem` SET `sortOrder`=80 WHERE `kind`='STAGE' AND `key`='ENROLLED';
UPDATE `LeadConfigItem` SET `active`=false WHERE `kind`='STAGE' AND `key` IN ('CONTACTED','NEGOTIATION','LOST');

INSERT INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`color`,`base`,`active`,`sortOrder`,`updatedAt`)
SELECT UUID(), 'STAGE', v.k, v.l, v.c, v.b, true, v.s, CURRENT_TIMESTAMP(3)
FROM (
  SELECT 'CUSTOM_DNP' AS k, 'DNP' AS l, 'slate' AS c, 'CONTACTED' AS b, 20 AS s
  UNION ALL SELECT 'CUSTOM_FOLLOW_UP',        'Follow Up',          'blue',   'CONTACTED',   30
  UNION ALL SELECT 'CUSTOM_REGISTRATION_DONE','Registration Done',  'orange', 'NEGOTIATION', 60
  UNION ALL SELECT 'CUSTOM_PARTIAL_PAYMENT',  'Partial Payment',    'orange', 'NEGOTIATION', 70
  UNION ALL SELECT 'CUSTOM_NOT_INTERESTED',   'Not Interested',     'red',    'LOST',        90
  UNION ALL SELECT 'CUSTOM_UNRESPONSIVE',     'Unresponsive',       'red',    'LOST',        100
  UNION ALL SELECT 'CUSTOM_MAYBE_LATER',      'May be Later',       'amber',  'CONTACTED',   110
  UNION ALL SELECT 'CUSTOM_POSITIVE',         'Positive',           'green',  'NEGOTIATION', 120
  UNION ALL SELECT 'CUSTOM_STUDENT',          'Student',            'purple', 'ENROLLED',    130
) v
WHERE NOT EXISTS (SELECT 1 FROM `LeadConfigItem` c WHERE c.`kind`='STAGE' AND c.`key`=v.k);

-- Activity statuses now land on the new stages.
UPDATE `LeadConfigItem` SET `targetStageKey`='CUSTOM_DNP'            WHERE `kind`='STATUS' AND `key`='DNP';
UPDATE `LeadConfigItem` SET `targetStageKey`='CUSTOM_FOLLOW_UP'      WHERE `kind`='STATUS' AND `key`='FOLLOW_UP';
UPDATE `LeadConfigItem` SET `targetStageKey`='CUSTOM_NOT_INTERESTED' WHERE `kind`='STATUS' AND `key` IN ('NOT_INTERESTED','DISQUALIFIED');

-- Existing leads move to the closest new stage.
UPDATE `Lead` SET `stageKey`='CUSTOM_FOLLOW_UP' WHERE `status`='CONTACTED'   AND `stageKey` IS NULL;
UPDATE `Lead` SET `stageKey`='CUSTOM_POSITIVE'  WHERE `status`='NEGOTIATION' AND `stageKey` IS NULL;
UPDATE `Lead` SET `stageKey`='CUSTOM_NOT_INTERESTED' WHERE `status`='LOST' AND `stageKey` IS NULL AND `lostReason`='NOT_INTERESTED';
UPDATE `Lead` SET `stageKey`='CUSTOM_UNRESPONSIVE'   WHERE `status`='LOST' AND `stageKey` IS NULL;
