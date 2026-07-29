-- Student deletion approval workflow: a "delete" click now only records a
-- pending request; the actual row + cascade delete happens when an Admin
-- approves it via a new endpoint.
ALTER TABLE `Student` ADD COLUMN `deletionRequestedAt` DATETIME(3) NULL;
ALTER TABLE `Student` ADD COLUMN `deletionRequestedById` VARCHAR(191) NULL;
ALTER TABLE `Student` ADD COLUMN `deletionReason` TEXT NULL;

CREATE INDEX `Student_deletionRequestedById_idx` ON `Student`(`deletionRequestedById`);

ALTER TABLE `Student` ADD CONSTRAINT `Student_deletionRequestedById_fkey` FOREIGN KEY (`deletionRequestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
