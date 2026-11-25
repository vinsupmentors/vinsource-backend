-- Trainer KRA for a completed sub-batch (one per trainer per sub-batch).
CREATE TABLE `TrainerBatchKra` (
  `id` VARCHAR(191) NOT NULL,
  `scheduleId` VARCHAR(191) NOT NULL,
  `trainerId` VARCHAR(191) NOT NULL,
  `summary` TEXT NOT NULL,
  `achievements` TEXT NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `TrainerBatchKra_scheduleId_trainerId_key`(`scheduleId`, `trainerId`),
  INDEX `TrainerBatchKra_trainerId_idx`(`trainerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Trainer's non-class work log.
CREATE TABLE `TrainerOtherWork` (
  `id` VARCHAR(191) NOT NULL,
  `trainerId` VARCHAR(191) NOT NULL,
  `date` DATETIME(3) NOT NULL,
  `category` VARCHAR(191) NOT NULL,
  `description` TEXT NOT NULL,
  `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `TrainerOtherWork_trainerId_date_idx`(`trainerId`, `date`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `TrainerBatchKra` ADD CONSTRAINT `TrainerBatchKra_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TrainerBatchKra` ADD CONSTRAINT `TrainerBatchKra_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `TrainerOtherWork` ADD CONSTRAINT `TrainerOtherWork_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
