-- Call / online-demo transcripts (free self-hosted Whisper) + audio capture fields on Demo
ALTER TABLE `Demo`
  ADD COLUMN `audioEgressId` VARCHAR(191) NULL,
  ADD COLUMN `audioKey` VARCHAR(191) NULL;

CREATE TABLE `CallTranscript` (
  `id` VARCHAR(191) NOT NULL,
  `sourceType` VARCHAR(191) NOT NULL,
  `sourceId` VARCHAR(191) NOT NULL,
  `leadId` VARCHAR(191) NULL,
  `ownerId` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `language` VARCHAR(191) NULL,
  `durationSec` INTEGER NULL,
  `text` LONGTEXT NULL,
  `segments` JSON NULL,
  `summary` TEXT NULL,
  `actionItems` JSON NULL,
  `topics` JSON NULL,
  `error` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `finishedAt` DATETIME(3) NULL,
  UNIQUE INDEX `CallTranscript_sourceType_sourceId_key`(`sourceType`, `sourceId`),
  INDEX `CallTranscript_status_idx`(`status`),
  INDEX `CallTranscript_leadId_idx`(`leadId`),
  INDEX `CallTranscript_ownerId_idx`(`ownerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
