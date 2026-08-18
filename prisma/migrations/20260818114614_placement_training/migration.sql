-- Standalone Placement Training content system (Projects + Tests) for
-- Softskill/Aptitude sessions. Mirrors Project/OnlineTest field-for-field but
-- keys releases off SoftskillSession instead of BatchCourseSchedule. Reuses
-- the existing ReleaseStatus / OnlineTestAttemptStatus / ProjectSubmissionStatus
-- / ViolationType enums.

-- CreateTable
CREATE TABLE `PlacementProject` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `resourceUrl` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementProjectRelease` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `releasedById` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `releasedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadline` DATETIME(3) NULL,

    UNIQUE INDEX `PlacementProjectRelease_projectId_sessionId_key`(`projectId`, `sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementProjectSubmission` (
    `id` VARCHAR(191) NOT NULL,
    `releaseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `fileUrl` VARCHAR(191) NULL,
    `linkUrl` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `status` ENUM('SUBMITTED', 'REVIEWED') NOT NULL DEFAULT 'SUBMITTED',
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewNote` TEXT NULL,
    `grade` DOUBLE NULL,
    `maxGrade` DOUBLE NULL DEFAULT 100,

    UNIQUE INDEX `PlacementProjectSubmission_releaseId_studentId_key`(`releaseId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementTest` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `durationMinutes` INTEGER NOT NULL DEFAULT 45,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementTestQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `testId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `prompt` TEXT NOT NULL,
    `options` JSON NOT NULL,
    `correctIndex` INTEGER NOT NULL,
    `marks` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `PlacementTestQuestion_testId_order_key`(`testId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementTestRelease` (
    `id` VARCHAR(191) NOT NULL,
    `testId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `activatedById` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `activatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadline` DATETIME(3) NULL,

    UNIQUE INDEX `PlacementTestRelease_testId_sessionId_key`(`testId`, `sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementTestAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `releaseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadlineAt` DATETIME(3) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `status` ENUM('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED_VIOLATION', 'EXPIRED') NOT NULL DEFAULT 'IN_PROGRESS',
    `score` INTEGER NULL,
    `totalMarks` INTEGER NULL,
    `violationCount` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `PlacementTestAttempt_releaseId_studentId_key`(`releaseId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementTestAnswer` (
    `id` VARCHAR(191) NOT NULL,
    `attemptId` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `selectedIndex` INTEGER NULL,
    `isCorrect` BOOLEAN NULL,

    UNIQUE INDEX `PlacementTestAnswer_attemptId_questionId_key`(`attemptId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementTestViolationSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `attemptId` VARCHAR(191) NOT NULL,
    `type` ENUM('TAB_SWITCH', 'NO_FACE', 'MULTIPLE_FACES', 'LOOKING_AWAY') NOT NULL,
    `snapshotUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PlacementTestViolationSnapshot_attemptId_idx`(`attemptId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PlacementProject` ADD CONSTRAINT `PlacementProject_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementProjectRelease` ADD CONSTRAINT `PlacementProjectRelease_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `PlacementProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementProjectRelease` ADD CONSTRAINT `PlacementProjectRelease_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `SoftskillSession`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementProjectRelease` ADD CONSTRAINT `PlacementProjectRelease_releasedById_fkey` FOREIGN KEY (`releasedById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementProjectSubmission` ADD CONSTRAINT `PlacementProjectSubmission_releaseId_fkey` FOREIGN KEY (`releaseId`) REFERENCES `PlacementProjectRelease`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementProjectSubmission` ADD CONSTRAINT `PlacementProjectSubmission_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementProjectSubmission` ADD CONSTRAINT `PlacementProjectSubmission_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTest` ADD CONSTRAINT `PlacementTest_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestQuestion` ADD CONSTRAINT `PlacementTestQuestion_testId_fkey` FOREIGN KEY (`testId`) REFERENCES `PlacementTest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestRelease` ADD CONSTRAINT `PlacementTestRelease_testId_fkey` FOREIGN KEY (`testId`) REFERENCES `PlacementTest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestRelease` ADD CONSTRAINT `PlacementTestRelease_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `SoftskillSession`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestRelease` ADD CONSTRAINT `PlacementTestRelease_activatedById_fkey` FOREIGN KEY (`activatedById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestAttempt` ADD CONSTRAINT `PlacementTestAttempt_releaseId_fkey` FOREIGN KEY (`releaseId`) REFERENCES `PlacementTestRelease`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestAttempt` ADD CONSTRAINT `PlacementTestAttempt_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestAnswer` ADD CONSTRAINT `PlacementTestAnswer_attemptId_fkey` FOREIGN KEY (`attemptId`) REFERENCES `PlacementTestAttempt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestAnswer` ADD CONSTRAINT `PlacementTestAnswer_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `PlacementTestQuestion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementTestViolationSnapshot` ADD CONSTRAINT `PlacementTestViolationSnapshot_attemptId_fkey` FOREIGN KEY (`attemptId`) REFERENCES `PlacementTestAttempt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
