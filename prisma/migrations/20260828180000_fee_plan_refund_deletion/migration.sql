-- Refund (Sales requests, Admin completes the transfer) and delete-request
-- (Sales requests, Admin approves) workflow on FeePaymentPlan, mirroring
-- the existing Student deletion-request pattern.

-- AlterTable
ALTER TABLE `FeePaymentPlan` MODIFY `status` ENUM('ACTIVE', 'CANCELLED', 'COMPLETED', 'REFUNDED') NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE `FeePaymentPlan` ADD COLUMN `refundRequestedAt` DATETIME(3) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `refundRequestedById` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `refundAmount` DOUBLE NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `refundReason` TEXT NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `refundCompletedAt` DATETIME(3) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `refundCompletedById` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `deletionRequestedAt` DATETIME(3) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `deletionRequestedById` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `deletionReason` TEXT NULL;

-- AddForeignKey
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_refundRequestedById_fkey` FOREIGN KEY (`refundRequestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_refundCompletedById_fkey` FOREIGN KEY (`refundCompletedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_deletionRequestedById_fkey` FOREIGN KEY (`deletionRequestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
