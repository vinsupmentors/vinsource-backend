ALTER TABLE `FeeInstallment` ADD COLUMN `rejectedAt` DATETIME(3) NULL,
    ADD COLUMN `rejectReason` TEXT NULL,
    ADD COLUMN `rejectedById` VARCHAR(191) NULL;

CREATE TABLE `CourseFee` (
    `id` VARCHAR(191) NOT NULL,
    `courseName` VARCHAR(191) NOT NULL,
    `fee` DOUBLE NOT NULL,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CourseFee_courseName_key`(`courseName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
