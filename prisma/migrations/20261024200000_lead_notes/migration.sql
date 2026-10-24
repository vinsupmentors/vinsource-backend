-- Standalone lead notes
CREATE TABLE `LeadNote` (
  `id` VARCHAR(191) NOT NULL,
  `leadId` VARCHAR(191) NOT NULL,
  `authorId` VARCHAR(191) NULL,
  `body` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `LeadNote_leadId_createdAt_idx`(`leadId`, `createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `LeadNote` ADD CONSTRAINT `LeadNote_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `LeadNote` ADD CONSTRAINT `LeadNote_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
