-- Sales Finance: fee declarations (Full / Part-payment / EMI) captured
-- against a Lead at intake, with per-installment tracking and a dedupe log
-- for the daily payment-reminder cron. Deliberately keyed off Lead (not
-- Student) so a dropped admission or refund never has to touch enrollment
-- data.

-- CreateTable
CREATE TABLE `FeePaymentPlan` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `courseName` VARCHAR(191) NOT NULL,
    `totalFee` DOUBLE NOT NULL,
    `planType` ENUM('FULL', 'PART', 'EMI') NOT NULL DEFAULT 'FULL',
    `interestAmount` DOUBLE NULL,
    `status` ENUM('ACTIVE', 'CANCELLED', 'COMPLETED') NOT NULL DEFAULT 'ACTIVE',
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- CreateTable
CREATE TABLE `FeeInstallment` (
    `id` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `dueDate` DATETIME(3) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `status` ENUM('PENDING', 'PAID', 'OVERDUE', 'WAIVED') NOT NULL DEFAULT 'PENDING',
    `paidAt` DATETIME(3) NULL,
    `mode` ENUM('CASH', 'UPI', 'CARD', 'NET_BANKING', 'CHEQUE', 'OTHER') NULL,
    `receivedById` VARCHAR(191) NULL,
    `collectionId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FeeInstallment_collectionId_key`(`collectionId`),
    INDEX `FeeInstallment_planId_idx`(`planId`),
    INDEX `FeeInstallment_dueDate_idx`(`dueDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- CreateTable
CREATE TABLE `FeeReminderLog` (
    `id` VARCHAR(191) NOT NULL,
    `installmentId` VARCHAR(191) NOT NULL,
    `type` ENUM('T5', 'DUE', 'OVERDUE') NOT NULL,
    `asOfDate` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FeeReminderLog_installmentId_type_asOfDate_key`(`installmentId`, `type`, `asOfDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- AddForeignKey
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeeInstallment` ADD CONSTRAINT `FeeInstallment_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `FeePaymentPlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeeInstallment` ADD CONSTRAINT `FeeInstallment_receivedById_fkey` FOREIGN KEY (`receivedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeeInstallment` ADD CONSTRAINT `FeeInstallment_collectionId_fkey` FOREIGN KEY (`collectionId`) REFERENCES `FeeCollection`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeeReminderLog` ADD CONSTRAINT `FeeReminderLog_installmentId_fkey` FOREIGN KEY (`installmentId`) REFERENCES `FeeInstallment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
