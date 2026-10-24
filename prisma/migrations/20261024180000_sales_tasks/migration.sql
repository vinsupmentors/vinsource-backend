-- Sales tasks / reminders
CREATE TABLE `SalesTask` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `description` TEXT NULL,
  `leadId` VARCHAR(191) NULL,
  `assignedToId` VARCHAR(191) NOT NULL,
  `createdById` VARCHAR(191) NULL,
  `dueAt` DATETIME(3) NULL,
  `status` ENUM('OPEN', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
  `completedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `SalesTask_assignedToId_status_idx`(`assignedToId`, `status`),
  INDEX `SalesTask_leadId_idx`(`leadId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SalesTask` ADD CONSTRAINT `SalesTask_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `SalesTask` ADD CONSTRAINT `SalesTask_assignedToId_fkey` FOREIGN KEY (`assignedToId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `SalesTask` ADD CONSTRAINT `SalesTask_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
