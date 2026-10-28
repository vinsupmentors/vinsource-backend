ALTER TABLE `FeeInstallment` ADD COLUMN `scheduled` BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE `SalesTask` ADD COLUMN `installmentId` VARCHAR(191) NULL;
CREATE INDEX `SalesTask_installmentId_idx` ON `SalesTask`(`installmentId`);
