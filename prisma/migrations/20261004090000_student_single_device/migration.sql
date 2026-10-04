-- Student portal single-device lock + admin-approved device change requests.

ALTER TABLE `User`
  ADD COLUMN `boundDeviceId` VARCHAR(191) NULL,
  ADD COLUMN `boundDeviceLabel` VARCHAR(191) NULL,
  ADD COLUMN `boundDeviceAt` DATETIME(3) NULL;

CREATE TABLE `StudentDeviceChangeRequest` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `newDeviceId` VARCHAR(191) NOT NULL,
  `newDeviceLabel` VARCHAR(512) NULL,
  `ipAddress` VARCHAR(191) NULL,
  `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `reviewedById` VARCHAR(191) NULL,
  `reviewedAt` DATETIME(3) NULL,
  `reviewNote` TEXT NULL,

  INDEX `StudentDeviceChangeRequest_userId_status_idx`(`userId`, `status`),
  INDEX `StudentDeviceChangeRequest_status_requestedAt_idx`(`status`, `requestedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `StudentDeviceChangeRequest`
  ADD CONSTRAINT `StudentDeviceChangeRequest_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
