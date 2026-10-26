-- Saved advanced filters
CREATE TABLE `SavedFilter` (
  `id` VARCHAR(191) NOT NULL,
  `scope` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `tree` JSON NOT NULL,
  `ownerId` VARCHAR(191) NULL,
  `shared` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `SavedFilter_scope_ownerId_idx`(`scope`, `ownerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
