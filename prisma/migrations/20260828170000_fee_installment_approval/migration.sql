-- Fee installments now hold at PENDING_APPROVAL the moment Sales collects
-- them — money isn't treated as received (ledger entry created, receipt
-- emailed) until someone with FINANCE_SALES ADMIN access approves it.

-- AlterTable
ALTER TABLE `FeeInstallment` MODIFY `status` ENUM('PENDING', 'PENDING_APPROVAL', 'PAID', 'OVERDUE', 'WAIVED') NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE `FeeInstallment` ADD COLUMN `approvedById` VARCHAR(191) NULL;
ALTER TABLE `FeeInstallment` ADD COLUMN `approvedAt` DATETIME(3) NULL;

-- AddForeignKey
ALTER TABLE `FeeInstallment` ADD CONSTRAINT `FeeInstallment_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
