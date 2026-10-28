ALTER TABLE `ReportSheet` ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'GRID',
    ADD COLUMN `liveKey` VARCHAR(191) NULL;

CREATE TABLE `BdaDailyTarget` (
    `employeeId` VARCHAR(191) NOT NULL,
    `bookingTarget` INTEGER NOT NULL DEFAULT 5,
    `demoTarget` INTEGER NOT NULL DEFAULT 2,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`employeeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
