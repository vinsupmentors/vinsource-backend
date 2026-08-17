-- Track when (and to which address) a BatchCertificate was last emailed.

ALTER TABLE `BatchCertificate`
  ADD COLUMN `emailedAt` DATETIME(3) NULL,
  ADD COLUMN `emailedTo` VARCHAR(191) NULL;
