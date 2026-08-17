-- Sales KPI suite, phase 1: per-employee monthly enrollment + revenue targets.

CREATE TABLE `SalesTarget` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `enrollmentGoal` INTEGER NOT NULL DEFAULT 0,
    `revenueGoal` DOUBLE NOT NULL DEFAULT 0,
    `setById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SalesTarget_employeeId_month_year_key`(`employeeId`, `month`, `year`),
    INDEX `SalesTarget_employeeId_idx`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SalesTarget` ADD CONSTRAINT `SalesTarget_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SalesTarget` ADD CONSTRAINT `SalesTarget_setById_fkey` FOREIGN KEY (`setById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
