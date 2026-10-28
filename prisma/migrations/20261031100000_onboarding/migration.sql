-- Onboarding: batch preferences + payment method, with payment proof / OCR check on instalments.
ALTER TABLE `FeeInstallment` ADD COLUMN `proofFile` VARCHAR(191) NULL,
    ADD COLUMN `ocrAmount` DOUBLE NULL,
    ADD COLUMN `ocrReference` VARCHAR(191) NULL,
    ADD COLUMN `amountMatched` BOOLEAN NULL;

CREATE TABLE `LeadOnboarding` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `courseName` VARCHAR(191) NOT NULL,
    `daysType` VARCHAR(191) NOT NULL,
    `timing` VARCHAR(191) NOT NULL,
    `mode` VARCHAR(191) NOT NULL,
    `paymentMethod` VARCHAR(191) NOT NULL,
    `totalFee` DOUBLE NULL,
    `registrationPaid` BOOLEAN NOT NULL DEFAULT false,
    `planId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LeadOnboarding_leadId_key`(`leadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LeadOnboarding` ADD CONSTRAINT `LeadOnboarding_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
