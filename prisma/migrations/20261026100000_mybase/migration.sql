-- MyBase: pool of unassigned leads, bulk hand-out with batch label and optional history hiding
ALTER TABLE `Lead`
  ADD COLUMN `assignedAt` DATETIME(3) NULL,
  ADD COLUMN `batchLabel` VARCHAR(191) NULL,
  ADD COLUMN `historyHiddenBefore` DATETIME(3) NULL;

CREATE INDEX `Lead_batchLabel_idx` ON `Lead`(`batchLabel`);
