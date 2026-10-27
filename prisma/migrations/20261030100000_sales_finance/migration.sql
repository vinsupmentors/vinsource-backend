-- JODO (third-party EMI/payment partner) as a payment mode + a payment reference for finance to match against.
ALTER TABLE `FeeCollection` MODIFY `mode` ENUM('CASH', 'UPI', 'CARD', 'NET_BANKING', 'CHEQUE', 'JODO', 'OTHER') NOT NULL DEFAULT 'UPI';
ALTER TABLE `FeeInstallment` MODIFY `mode` ENUM('CASH', 'UPI', 'CARD', 'NET_BANKING', 'CHEQUE', 'JODO', 'OTHER') NULL;
ALTER TABLE `FeeInstallment` ADD COLUMN `reference` VARCHAR(191) NULL;
