ALTER TABLE `Demo` ADD COLUMN `completedAt` DATETIME(3) NULL;
UPDATE `Demo` SET `completedAt` = `updatedAt` WHERE `status` = 'COMPLETED' AND `completedAt` IS NULL;

CREATE TABLE `DemoFeedback` (
  `id` VARCHAR(191) NOT NULL,
  `demoId` VARCHAR(191) NOT NULL,
  `token` VARCHAR(191) NOT NULL,
  `releasedById` VARCHAR(191) NULL,
  `releasedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `submittedAt` DATETIME(3) NULL,
  `overall` INTEGER NULL,
  `trainer` INTEGER NULL,
  `content` INTEGER NULL,
  `pace` VARCHAR(191) NULL,
  `doubts` VARCHAR(191) NULL,
  `joinIntent` VARCHAR(191) NULL,
  `liked` TEXT NULL,
  `improve` TEXT NULL,
  `studentName` VARCHAR(191) NULL,
  UNIQUE INDEX `DemoFeedback_demoId_key`(`demoId`),
  UNIQUE INDEX `DemoFeedback_token_key`(`token`),
  INDEX `DemoFeedback_submittedAt_idx`(`submittedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `DemoFeedback` ADD CONSTRAINT `DemoFeedback_demoId_fkey` FOREIGN KEY (`demoId`) REFERENCES `Demo`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
