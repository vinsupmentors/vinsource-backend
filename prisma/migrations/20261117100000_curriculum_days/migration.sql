-- Day-wise curriculum: one row per teaching day of a course.
CREATE TABLE `CurriculumDay` (
  `id` VARCHAR(191) NOT NULL,
  `courseId` VARCHAR(191) NOT NULL,
  `moduleId` VARCHAR(191) NULL,
  `dayNumber` INTEGER NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `topics` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `CurriculumDay_courseId_dayNumber_key`(`courseId`, `dayNumber`),
  INDEX `CurriculumDay_moduleId_idx`(`moduleId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- A trainer releasing a day to one sub-batch.
CREATE TABLE `CurriculumDayRelease` (
  `id` VARCHAR(191) NOT NULL,
  `dayId` VARCHAR(191) NOT NULL,
  `scheduleId` VARCHAR(191) NOT NULL,
  `releasedById` VARCHAR(191) NULL,
  `releasedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `CurriculumDayRelease_dayId_scheduleId_key`(`dayId`, `scheduleId`),
  INDEX `CurriculumDayRelease_scheduleId_idx`(`scheduleId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Day-wise files hang off a day.
ALTER TABLE `CourseMaterial` ADD COLUMN `dayId` VARCHAR(191) NULL;
CREATE INDEX `CourseMaterial_dayId_idx` ON `CourseMaterial`(`dayId`);

ALTER TABLE `CurriculumDay` ADD CONSTRAINT `CurriculumDay_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CurriculumDayRelease` ADD CONSTRAINT `CurriculumDayRelease_dayId_fkey` FOREIGN KEY (`dayId`) REFERENCES `CurriculumDay`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CourseMaterial` ADD CONSTRAINT `CourseMaterial_dayId_fkey` FOREIGN KEY (`dayId`) REFERENCES `CurriculumDay`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
