-- AlterTable: Lead gets denormalized "Reminder" / "Last Contact" columns
ALTER TABLE `Lead` ADD COLUMN `lastContactAt` DATETIME(3) NULL;
ALTER TABLE `Lead` ADD COLUMN `nextFollowUpAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `LeadCallLog` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `calledById` VARCHAR(191) NULL,
    `notes` TEXT NOT NULL,
    `nextFollowUpAt` DATETIME(3) NULL,
    `calledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: Demo gains mode, a proper status enum (keeping existing
-- SCHEDULED/COMPLETED values so current rows survive the type change),
-- a reschedule trail, and updatedAt (defaulted to now() so existing rows
-- backfill cleanly).
ALTER TABLE `Demo` ADD COLUMN `mode` ENUM('ONLINE', 'OFFLINE') NOT NULL DEFAULT 'ONLINE';
ALTER TABLE `Demo` ADD COLUMN `rescheduledFromId` VARCHAR(191) NULL;
ALTER TABLE `Demo` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE `Demo` MODIFY COLUMN `status` ENUM('SCHEDULED', 'COMPLETED', 'RESCHEDULED', 'NO_SHOW', 'CANCELLED') NOT NULL DEFAULT 'SCHEDULED';

-- CreateIndex
CREATE UNIQUE INDEX `Demo_rescheduledFromId_key` ON `Demo`(`rescheduledFromId`);

-- AddForeignKey
ALTER TABLE `LeadCallLog` ADD CONSTRAINT `LeadCallLog_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `LeadCallLog` ADD CONSTRAINT `LeadCallLog_calledById_fkey` FOREIGN KEY (`calledById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Demo` ADD CONSTRAINT `Demo_rescheduledFromId_fkey` FOREIGN KEY (`rescheduledFromId`) REFERENCES `Demo`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: ReportRecipient gains the SALES_HOURLY type (enum widened; existing rows unaffected)
ALTER TABLE `ReportRecipient` MODIFY COLUMN `type` ENUM('DAILY_ATTENDANCE', 'ESCALATION', 'SALES_HOURLY') NOT NULL;
