-- SIM-based call tracking: SalesDevice registry + auto-logged LeadCallLog fields.

CREATE TABLE `SalesDevice` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NULL,
    `deviceToken` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastSeenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SalesDevice_deviceToken_key`(`deviceToken`),
    INDEX `SalesDevice_employeeId_idx`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SalesDevice` ADD CONSTRAINT `SalesDevice_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- LeadCallLog: leadId/notes become nullable (unmatched-call review queue rows
-- have no lead yet and no BDA notes yet), plus the auto-logging columns.
ALTER TABLE `LeadCallLog`
    MODIFY COLUMN `leadId` VARCHAR(191) NULL,
    MODIFY COLUMN `notes` TEXT NULL,
    ADD COLUMN `source` ENUM('MANUAL', 'AUTO') NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN `direction` ENUM('INBOUND', 'OUTBOUND', 'MISSED') NULL,
    ADD COLUMN `durationSeconds` INTEGER NULL,
    ADD COLUMN `recordingUrl` VARCHAR(191) NULL,
    ADD COLUMN `rawPhoneNumber` VARCHAR(191) NULL,
    ADD COLUMN `deviceId` VARCHAR(191) NULL;

CREATE INDEX `LeadCallLog_leadId_idx` ON `LeadCallLog`(`leadId`);
CREATE INDEX `LeadCallLog_deviceId_idx` ON `LeadCallLog`(`deviceId`);

ALTER TABLE `LeadCallLog` ADD CONSTRAINT `LeadCallLog_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `SalesDevice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
