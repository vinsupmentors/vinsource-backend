-- Live Classes Phase 2: attendance-from-video. Computed once when a class
-- ends (see liveClasses.controller.ts `end`), summing LiveClassParticipant
-- join/leave sessions against the class's actual duration. Deliberately its
-- own table, not a reuse of StudentAttendance (no percentage/duration
-- concept there, and it's driven by a trainer's own manual daily marking).

-- CreateTable
CREATE TABLE `LiveClassAttendance` (
    `id` VARCHAR(191) NOT NULL,
    `liveClassId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `status` ENUM('PRESENT', 'PARTIAL', 'ABSENT') NOT NULL,
    `attendedMinutes` INTEGER NOT NULL,
    `classMinutes` INTEGER NOT NULL,
    `percentAttended` INTEGER NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LiveClassAttendance_liveClassId_studentId_key`(`liveClassId`, `studentId`),
    INDEX `LiveClassAttendance_studentId_idx`(`studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LiveClassAttendance` ADD CONSTRAINT `LiveClassAttendance_liveClassId_fkey` FOREIGN KEY (`liveClassId`) REFERENCES `LiveClass`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `LiveClassAttendance` ADD CONSTRAINT `LiveClassAttendance_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
