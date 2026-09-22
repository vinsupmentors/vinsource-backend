-- Live Classes (Phase 1: core classroom, no recording/storage yet).
-- A class always hangs off one BatchCourseSchedule, reusing its existing
-- StudentBatchEnrollment (batch-based student access) and TrainerAssignment
-- (trainer/co-trainer host access) rows instead of a separate ACL table.

-- AlterEnum: ModuleName — add LIVE_CLASSES
ALTER TABLE `DepartmentModuleAccess`
  MODIFY COLUMN `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING', 'CERTIFICATES', 'STUDENT_ONBOARDING', 'ADMISSION', 'LIVE_CLASSES') NOT NULL;
ALTER TABLE `UserModuleAccess`
  MODIFY COLUMN `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING', 'CERTIFICATES', 'STUDENT_ONBOARDING', 'ADMISSION', 'LIVE_CLASSES') NOT NULL;

-- CreateTable
CREATE TABLE `LiveClass` (
    `id` VARCHAR(191) NOT NULL,
    `classCode` VARCHAR(191) NOT NULL,
    `roomName` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `topic` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `scheduledDate` DATETIME(3) NOT NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,
    `actualStartAt` DATETIME(3) NULL,
    `actualEndAt` DATETIME(3) NULL,
    `status` ENUM('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` TEXT NULL,
    `rescheduledFrom` DATETIME(3) NULL,
    `rescheduledReason` TEXT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LiveClass_classCode_key`(`classCode`),
    UNIQUE INDEX `LiveClass_roomName_key`(`roomName`),
    INDEX `LiveClass_scheduleId_idx`(`scheduleId`),
    INDEX `LiveClass_status_idx`(`status`),
    INDEX `LiveClass_scheduledDate_idx`(`scheduledDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveClassParticipant` (
    `id` VARCHAR(191) NOT NULL,
    `liveClassId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('HOST', 'CO_TRAINER', 'STUDENT') NOT NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `leftAt` DATETIME(3) NULL,

    INDEX `LiveClassParticipant_liveClassId_idx`(`liveClassId`),
    INDEX `LiveClassParticipant_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveClassChatMessage` (
    `id` VARCHAR(191) NOT NULL,
    `liveClassId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LiveClassChatMessage_liveClassId_idx`(`liveClassId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LiveClass` ADD CONSTRAINT `LiveClass_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `LiveClass` ADD CONSTRAINT `LiveClass_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveClassParticipant` ADD CONSTRAINT `LiveClassParticipant_liveClassId_fkey` FOREIGN KEY (`liveClassId`) REFERENCES `LiveClass`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `LiveClassParticipant` ADD CONSTRAINT `LiveClassParticipant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LiveClassChatMessage` ADD CONSTRAINT `LiveClassChatMessage_liveClassId_fkey` FOREIGN KEY (`liveClassId`) REFERENCES `LiveClass`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `LiveClassChatMessage` ADD CONSTRAINT `LiveClassChatMessage_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
