-- Demo sit-ins: a prospect joins an existing live class for a limited time, after approval.

CREATE TABLE `DemoSessionRequest` (
  `id` VARCHAR(191) NOT NULL,
  `mode` ENUM('ONLINE', 'OFFLINE') NOT NULL,
  `liveClassId` VARCHAR(191) NOT NULL,
  `scheduleId` VARCHAR(191) NOT NULL,
  `attendeeName` VARCHAR(191) NOT NULL,
  `attendeeEmail` VARCHAR(191) NULL,
  `attendeePhone` VARCHAR(191) NULL,
  `leadId` VARCHAR(191) NULL,
  `requestedById` VARCHAR(191) NULL,
  `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
  `reviewedById` VARCHAR(191) NULL,
  `reviewedAt` DATETIME(3) NULL,
  `reviewNote` TEXT NULL,
  `accessCode` VARCHAR(191) NULL,
  `maxMinutes` INT NOT NULL DEFAULT 20,
  `joinedAt` DATETIME(3) NULL,
  `expiresAt` DATETIME(3) NULL,
  `cutAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `DemoSessionRequest_accessCode_key`(`accessCode`),
  INDEX `DemoSessionRequest_status_idx`(`status`),
  INDEX `DemoSessionRequest_liveClassId_idx`(`liveClassId`),
  INDEX `DemoSessionRequest_scheduleId_idx`(`scheduleId`),
  INDEX `DemoSessionRequest_requestedById_idx`(`requestedById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
