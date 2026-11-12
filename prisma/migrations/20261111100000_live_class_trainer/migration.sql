-- Trainer chosen per live class (overrides the schedule's assigned trainers on the card and lets them host it).
ALTER TABLE `LiveClass` ADD COLUMN `trainerId` VARCHAR(191) NULL;
CREATE INDEX `LiveClass_trainerId_idx` ON `LiveClass`(`trainerId`);
ALTER TABLE `LiveClass` ADD CONSTRAINT `LiveClass_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
