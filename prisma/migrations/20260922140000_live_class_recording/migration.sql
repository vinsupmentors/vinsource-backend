-- Live Classes Phase 2: recording. Uploaded via self-hosted LiveKit Egress
-- straight to a private Cloudflare R2 bucket. storageKey is an R2 object key
-- only, never a direct URL — playback always goes through a presigned URL
-- minted on request (see liveClasses.controller.ts `playRecording`).

-- CreateTable
CREATE TABLE `LiveClassRecording` (
    `id` VARCHAR(191) NOT NULL,
    `liveClassId` VARCHAR(191) NOT NULL,
    `egressId` VARCHAR(191) NOT NULL,
    `status` ENUM('RECORDING', 'READY', 'FAILED') NOT NULL DEFAULT 'RECORDING',
    `storageKey` VARCHAR(191) NULL,
    `durationSec` INTEGER NULL,
    `fileSizeBytes` BIGINT NULL,
    `failReason` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,

    UNIQUE INDEX `LiveClassRecording_egressId_key`(`egressId`),
    INDEX `LiveClassRecording_liveClassId_idx`(`liveClassId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LiveClassRecording` ADD CONSTRAINT `LiveClassRecording_liveClassId_fkey` FOREIGN KEY (`liveClassId`) REFERENCES `LiveClass`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
