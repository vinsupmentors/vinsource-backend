-- Real seat hold-back: admin can withhold N genuine seats from normal
-- booking (e.g. reserved for an anticipated college enrollment), and reps
-- can request their release through the portal instead of the display
-- fabricating scarcity.

-- AlterTable
ALTER TABLE `BatchCourseSchedule`
  ADD COLUMN `heldSeats` INT NULL DEFAULT 0,
  ADD COLUMN `heldOnlineSeats` INT NULL DEFAULT 0,
  ADD COLUMN `heldOfflineSeats` INT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `SeatHoldRequest` (
    `id` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `deliveryMode` ENUM('ONLINE', 'OFFLINE', 'HYBRID') NULL,
    `seatsRequested` INT NOT NULL DEFAULT 1,
    `reason` TEXT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `requestedById` VARCHAR(191) NULL,
    `respondedById` VARCHAR(191) NULL,
    `respondedAt` DATETIME(3) NULL,
    `responseNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SeatHoldRequest_scheduleId_idx`(`scheduleId`),
    INDEX `SeatHoldRequest_requestedById_idx`(`requestedById`),
    INDEX `SeatHoldRequest_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SeatHoldRequest` ADD CONSTRAINT `SeatHoldRequest_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SeatHoldRequest` ADD CONSTRAINT `SeatHoldRequest_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SeatHoldRequest` ADD CONSTRAINT `SeatHoldRequest_respondedById_fkey` FOREIGN KEY (`respondedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
