-- Camera-based proctoring evidence: one row per violation event (no face /
-- multiple faces / looking away / the original tab-switch check), with an
-- optional captured snapshot image. Cascades with the OnlineTestAttempt so a
-- reassigned test clears prior evidence along with the rest of the attempt.
CREATE TABLE `OnlineTestViolationSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `attemptId` VARCHAR(191) NOT NULL,
    `type` ENUM('TAB_SWITCH', 'NO_FACE', 'MULTIPLE_FACES', 'LOOKING_AWAY') NOT NULL,
    `snapshotUrl` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OnlineTestViolationSnapshot_attemptId_idx`(`attemptId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `OnlineTestViolationSnapshot` ADD CONSTRAINT `OnlineTestViolationSnapshot_attemptId_fkey` FOREIGN KEY (`attemptId`) REFERENCES `OnlineTestAttempt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
