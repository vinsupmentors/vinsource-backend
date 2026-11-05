CREATE TABLE `MetaLeadConfig` (
  `id` VARCHAR(191) NOT NULL DEFAULT 'default',
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `assignMode` VARCHAR(191) NOT NULL DEFAULT 'MY_BASE',
  `fixedOwnerId` VARCHAR(191) NULL,
  `roundRobinIds` TEXT NULL,
  `rrCursor` INTEGER NOT NULL DEFAULT 0,
  `defaultCourse` VARCHAR(191) NULL,
  `formCourseMap` TEXT NULL,
  `lastLeadAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `MetaLeadEvent` (
  `id` VARCHAR(191) NOT NULL,
  `leadgenId` VARCHAR(191) NOT NULL,
  `formId` VARCHAR(191) NULL,
  `pageId` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'RECEIVED',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `leadId` VARCHAR(191) NULL,
  `name` VARCHAR(191) NULL,
  `phone` VARCHAR(191) NULL,
  `campaign` VARCHAR(191) NULL,
  `error` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `MetaLeadEvent_leadgenId_key`(`leadgenId`),
  INDEX `MetaLeadEvent_status_idx`(`status`),
  INDEX `MetaLeadEvent_createdAt_idx`(`createdAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
