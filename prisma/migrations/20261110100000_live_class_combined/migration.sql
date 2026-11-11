-- Combined (Soft Skills & Aptitude) live classes: kind + extra schedules clubbed into one class.
ALTER TABLE `LiveClass` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'REGULAR';

CREATE TABLE `LiveClassSchedule` (
  `id` VARCHAR(191) NOT NULL,
  `liveClassId` VARCHAR(191) NOT NULL,
  `scheduleId` VARCHAR(191) NOT NULL,
  UNIQUE INDEX `LiveClassSchedule_liveClassId_scheduleId_key`(`liveClassId`, `scheduleId`),
  INDEX `LiveClassSchedule_scheduleId_idx`(`scheduleId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LiveClassSchedule` ADD CONSTRAINT `LiveClassSchedule_liveClassId_fkey` FOREIGN KEY (`liveClassId`) REFERENCES `LiveClass`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `LiveClassSchedule` ADD CONSTRAINT `LiveClassSchedule_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
