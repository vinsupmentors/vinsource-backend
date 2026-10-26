-- Duplicate control (phone key), duplicate dismissals, and email alert rules
ALTER TABLE `Lead` ADD COLUMN `phoneKey` VARCHAR(191) NULL;
CREATE INDEX `Lead_phoneKey_idx` ON `Lead`(`phoneKey`);

-- Backfill: last 10 digits of whatever was typed (spaces, dashes, +91, leading 0 all ignored)
UPDATE `Lead`
SET `phoneKey` = RIGHT(REGEXP_REPLACE(`phone`, '[^0-9]', ''), 10)
WHERE `phone` IS NOT NULL AND REGEXP_REPLACE(`phone`, '[^0-9]', '') <> '';

CREATE TABLE `LeadDuplicateDismissal` (
  `phoneKey` VARCHAR(191) NOT NULL,
  `dismissedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`phoneKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SalesAlertRule` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `type` VARCHAR(191) NOT NULL,
  `days` INTEGER NOT NULL DEFAULT 14,
  `activityStatus` VARCHAR(191) NULL,
  `includeMyBase` BOOLEAN NOT NULL DEFAULT true,
  `notifyOwner` BOOLEAN NOT NULL DEFAULT true,
  `notifyAdmins` BOOLEAN NOT NULL DEFAULT true,
  `adminEmails` TEXT NULL,
  `sendHour` INTEGER NOT NULL DEFAULT 9,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `lastSentOn` VARCHAR(191) NULL,
  `lastSentCount` INTEGER NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Starter rules (admin can edit / switch off on the Alerts screen)
INSERT INTO `SalesAlertRule` (`id`, `name`, `type`, `days`, `activityStatus`, `includeMyBase`, `notifyOwner`, `notifyAdmins`, `sendHour`, `active`, `updatedAt`) VALUES
  (UUID(), 'No activity for 14 days', 'NO_ACTIVITY', 14, NULL, true, true, true, 9, true, CURRENT_TIMESTAMP(3)),
  (UUID(), 'DNP for 3 days', 'STATUS_STALE', 3, 'DNP', false, true, true, 9, true, CURRENT_TIMESTAMP(3)),
  (UUID(), 'Follow-up overdue', 'FOLLOWUP_OVERDUE', 1, NULL, false, true, true, 9, true, CURRENT_TIMESTAMP(3));
