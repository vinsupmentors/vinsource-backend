-- Config-driven stages / statuses / lost reasons / sources / scouts, plus the Lead Scout field
ALTER TABLE `Lead`
  ADD COLUMN `stageKey` VARCHAR(191) NULL,
  ADD COLUMN `statusKey` VARCHAR(191) NULL,
  ADD COLUMN `lostReasonKey` VARCHAR(191) NULL,
  ADD COLUMN `scoutKey` VARCHAR(191) NULL;
CREATE INDEX `Lead_scoutKey_idx` ON `Lead`(`scoutKey`);

ALTER TABLE `LeadCallLog` ADD COLUMN `statusKey` VARCHAR(191) NULL;

CREATE TABLE `LeadConfigItem` (
  `id` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(191) NOT NULL,
  `key` VARCHAR(191) NOT NULL,
  `label` VARCHAR(191) NOT NULL,
  `color` VARCHAR(191) NULL,
  `base` VARCHAR(191) NULL,
  `targetStageKey` VARCHAR(191) NULL,
  `needsFollowUp` BOOLEAN NOT NULL DEFAULT false,
  `notesRequired` BOOLEAN NOT NULL DEFAULT true,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `system` BOOLEAN NOT NULL DEFAULT false,
  `sortOrder` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `LeadConfigItem_kind_key_key`(`kind`, `key`),
  INDEX `LeadConfigItem_kind_active_idx`(`kind`, `active`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Built-in lead stages (key = LeadStatus value, base = itself)
INSERT INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`color`,`base`,`system`,`sortOrder`,`updatedAt`) VALUES
  (UUID(),'STAGE','NEW','New','slate','NEW',true,10,CURRENT_TIMESTAMP(3)),
  (UUID(),'STAGE','CONTACTED','Contacted','blue','CONTACTED',true,20,CURRENT_TIMESTAMP(3)),
  (UUID(),'STAGE','DEMO_SCHEDULED','Demo Scheduled','amber','DEMO_SCHEDULED',true,30,CURRENT_TIMESTAMP(3)),
  (UUID(),'STAGE','DEMO_DONE','Demo Done','purple','DEMO_DONE',true,40,CURRENT_TIMESTAMP(3)),
  (UUID(),'STAGE','NEGOTIATION','Negotiation','orange','NEGOTIATION',true,50,CURRENT_TIMESTAMP(3)),
  (UUID(),'STAGE','ENROLLED','Enrolled','green','ENROLLED',true,60,CURRENT_TIMESTAMP(3)),
  (UUID(),'STAGE','LOST','Lost','red','LOST',true,70,CURRENT_TIMESTAMP(3));

-- Built-in update statuses (same behaviour as before: stage each moves to, follow-up needed, notes needed)
INSERT INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`color`,`base`,`targetStageKey`,`needsFollowUp`,`notesRequired`,`system`,`sortOrder`,`updatedAt`) VALUES
  (UUID(),'STATUS','DNP','DNP','slate','DNP','CONTACTED',true,false,true,10,CURRENT_TIMESTAMP(3)),
  (UUID(),'STATUS','FOLLOW_UP','Follow-up','blue','FOLLOW_UP','CONTACTED',true,true,true,20,CURRENT_TIMESTAMP(3)),
  (UUID(),'STATUS','DEMO_BOOKED','Demo booked','amber','DEMO_BOOKED','DEMO_SCHEDULED',true,true,true,30,CURRENT_TIMESTAMP(3)),
  (UUID(),'STATUS','DEMO_OVER','Demo over','purple','DEMO_OVER','DEMO_DONE',true,true,true,40,CURRENT_TIMESTAMP(3)),
  (UUID(),'STATUS','NOT_INTERESTED','Not interested','red','NOT_INTERESTED','LOST',false,true,true,50,CURRENT_TIMESTAMP(3)),
  (UUID(),'STATUS','DISQUALIFIED','Disqualified','red','DISQUALIFIED','LOST',false,true,true,60,CURRENT_TIMESTAMP(3));

-- Built-in lost reasons
INSERT INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`base`,`system`,`sortOrder`,`updatedAt`) VALUES
  (UUID(),'LOST_REASON','NOT_INTERESTED','Not Interested','NOT_INTERESTED',true,10,CURRENT_TIMESTAMP(3)),
  (UUID(),'LOST_REASON','INVALID_NUMBER','Invalid Number','INVALID_NUMBER',true,20,CURRENT_TIMESTAMP(3)),
  (UUID(),'LOST_REASON','UNREACHABLE','Unreachable / No Response','UNREACHABLE',true,30,CURRENT_TIMESTAMP(3)),
  (UUID(),'LOST_REASON','DUPLICATE','Duplicate Lead','DUPLICATE',true,40,CURRENT_TIMESTAMP(3)),
  (UUID(),'LOST_REASON','OTHER','Other','OTHER',true,50,CURRENT_TIMESTAMP(3));

-- Sources already used on leads (key = label = the text on the lead), plus the usual suspects
INSERT IGNORE INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`sortOrder`,`updatedAt`)
  SELECT UUID(), 'SOURCE', s.src, s.src, 100, CURRENT_TIMESTAMP(3)
  FROM (SELECT DISTINCT TRIM(`source`) AS src FROM `Lead` WHERE `source` IS NOT NULL AND TRIM(`source`) <> '') s;
INSERT IGNORE INTO `LeadConfigItem` (`id`,`kind`,`key`,`label`,`sortOrder`,`updatedAt`) VALUES
  (UUID(),'SOURCE','Meta','Meta',10,CURRENT_TIMESTAMP(3)),
  (UUID(),'SOURCE','Google','Google',20,CURRENT_TIMESTAMP(3)),
  (UUID(),'SOURCE','Walk-in','Walk-in',30,CURRENT_TIMESTAMP(3)),
  (UUID(),'SOURCE','Referral','Referral',40,CURRENT_TIMESTAMP(3));
