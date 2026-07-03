-- CreateTable
CREATE TABLE `BudgetAllocation` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `notes` VARCHAR(191) NULL,
    `allocatedDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `allocatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BudgetAllocation` ADD CONSTRAINT `BudgetAllocation_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BudgetAllocation` ADD CONSTRAINT `BudgetAllocation_allocatedById_fkey` FOREIGN KEY (`allocatedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
