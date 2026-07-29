-- Permanent audit trail for student deletions. Written just before the
-- Student row (and everything cascaded from it) is hard-deleted on approval,
-- so there's always a record of who was deleted, requested by whom/why, and
-- approved by whom/when -- even though the Student row itself is gone.
CREATE TABLE `StudentDeletionLog` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `studentCode` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `track` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `courseName` VARCHAR(191) NULL,
    `batchCode` VARCHAR(191) NULL,
    `deletionReason` TEXT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `requestedById` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `approvedById` VARCHAR(191) NULL,
    `forced` BOOLEAN NOT NULL DEFAULT false,
    `attendanceCount` INTEGER NOT NULL DEFAULT 0,
    `testAttemptCount` INTEGER NOT NULL DEFAULT 0,
    `placementResultCount` INTEGER NOT NULL DEFAULT 0,

    INDEX `StudentDeletionLog_studentCode_idx`(`studentCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StudentDeletionLog` ADD CONSTRAINT `StudentDeletionLog_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `StudentDeletionLog` ADD CONSTRAINT `StudentDeletionLog_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
