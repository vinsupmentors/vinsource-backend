-- CreateTable
CREATE TABLE `SoftskillFeedback` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `trainerId` VARCHAR(191) NULL,
    `performanceRating` INTEGER NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SoftskillFeedback_sessionId_studentId_key`(`sessionId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SoftskillFeedback` ADD CONSTRAINT `SoftskillFeedback_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `SoftskillSession`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SoftskillFeedback` ADD CONSTRAINT `SoftskillFeedback_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SoftskillFeedback` ADD CONSTRAINT `SoftskillFeedback_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
