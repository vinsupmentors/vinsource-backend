-- Permanent snapshot of deleted fee declarations — survives the plan row
-- itself being deleted, so Admin can still see a history of what was
-- removed, by whom, and why.

-- CreateTable
CREATE TABLE `FeePlanDeletionLog` (
    `id` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `leadName` VARCHAR(191) NOT NULL,
    `leadPhone` VARCHAR(191) NOT NULL,
    `courseName` VARCHAR(191) NOT NULL,
    `totalFee` DOUBLE NOT NULL,
    `planType` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `totalPaid` DOUBLE NOT NULL,
    `deletionReason` TEXT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `requestedById` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `approvedById` VARCHAR(191) NULL,

    INDEX `FeePlanDeletionLog_planId_idx`(`planId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `FeePlanDeletionLog` ADD CONSTRAINT `FeePlanDeletionLog_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeePlanDeletionLog` ADD CONSTRAINT `FeePlanDeletionLog_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
