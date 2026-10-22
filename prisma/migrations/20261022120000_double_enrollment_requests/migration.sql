-- Double-enrollment approval requests
CREATE TABLE `DoubleEnrollmentRequest` (
  `id` VARCHAR(191) NOT NULL,
  `studentId` VARCHAR(191) NOT NULL,
  `scheduleId` VARCHAR(191) NOT NULL,
  `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  `reason` TEXT NULL,
  `requestedById` VARCHAR(191) NULL,
  `reviewedById` VARCHAR(191) NULL,
  `reviewedAt` DATETIME(3) NULL,
  `reviewNote` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `DoubleEnrollmentRequest_status_idx`(`status`),
  INDEX `DoubleEnrollmentRequest_studentId_idx`(`studentId`),
  INDEX `DoubleEnrollmentRequest_scheduleId_idx`(`scheduleId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DoubleEnrollmentRequest` ADD CONSTRAINT `DoubleEnrollmentRequest_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DoubleEnrollmentRequest` ADD CONSTRAINT `DoubleEnrollmentRequest_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `DoubleEnrollmentRequest` ADD CONSTRAINT `DoubleEnrollmentRequest_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `DoubleEnrollmentRequest` ADD CONSTRAINT `DoubleEnrollmentRequest_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
