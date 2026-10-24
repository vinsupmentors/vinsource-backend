-- Lead activity status, soft delete and full history trail
ALTER TABLE `Lead`
  ADD COLUMN `activityStatus` ENUM('DNP', 'FOLLOW_UP', 'DEMO_BOOKED', 'DEMO_OVER', 'NOT_INTERESTED', 'DISQUALIFIED') NULL,
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedById` VARCHAR(191) NULL,
  ADD COLUMN `createdById` VARCHAR(191) NULL;

ALTER TABLE `LeadCallLog`
  ADD COLUMN `activityType` ENUM('CALL', 'MEETING') NULL,
  ADD COLUMN `activityStatus` ENUM('DNP', 'FOLLOW_UP', 'DEMO_BOOKED', 'DEMO_OVER', 'NOT_INTERESTED', 'DISQUALIFIED') NULL;

CREATE TABLE `LeadHistory` (
  `id` VARCHAR(191) NOT NULL,
  `leadId` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NULL,
  `type` VARCHAR(191) NOT NULL,
  `summary` TEXT NOT NULL,
  `fromValue` VARCHAR(191) NULL,
  `toValue` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `LeadHistory_leadId_createdAt_idx`(`leadId`, `createdAt`),
  INDEX `LeadHistory_actorId_idx`(`actorId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LeadHistory` ADD CONSTRAINT `LeadHistory_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `LeadHistory` ADD CONSTRAINT `LeadHistory_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Give every existing lead a "created" entry so its history starts at creation.
INSERT INTO `LeadHistory` (`id`, `leadId`, `type`, `summary`, `toValue`, `createdAt`)
SELECT UUID(), `id`, 'CREATED', CONCAT('Lead created', IF(`source` IS NULL OR `source` = '', '', CONCAT(' (source: ', `source`, ')'))), `source`, `createdAt`
FROM `Lead`;
