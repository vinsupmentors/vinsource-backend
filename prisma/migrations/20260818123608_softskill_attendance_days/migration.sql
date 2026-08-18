-- CreateTable
CREATE TABLE `SoftskillAttendanceDay` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `status` ENUM('PRESENT', 'ABSENT', 'LATE') NOT NULL DEFAULT 'PRESENT',
    `score` DOUBLE NULL,
    `remarks` TEXT NULL,
    `markedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `SoftskillAttendanceDay_sessionId_studentId_date_key`(`sessionId`, `studentId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SoftskillAttendanceDay` ADD CONSTRAINT `SoftskillAttendanceDay_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `SoftskillSession`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SoftskillAttendanceDay` ADD CONSTRAINT `SoftskillAttendanceDay_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SoftskillAttendanceDay` ADD CONSTRAINT `SoftskillAttendanceDay_markedById_fkey` FOREIGN KEY (`markedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
