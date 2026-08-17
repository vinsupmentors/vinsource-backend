-- Bulk, per-student Course Completion certificates for a Batch, with an
-- actually-persisted photo (unlike GeneratedCertificate's placeholder).

CREATE TABLE `BatchCertificate` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `certNo` VARCHAR(191) NOT NULL,
    `studentName` VARCHAR(191) NOT NULL,
    `studentCode` VARCHAR(191) NOT NULL,
    `course` VARCHAR(191) NOT NULL,
    `batchLabel` VARCHAR(191) NOT NULL,
    `issuedOn` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `photoUrl` VARCHAR(191) NULL,
    `generatedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `BatchCertificate_certNo_key`(`certNo`),
    UNIQUE INDEX `BatchCertificate_studentId_batchId_key`(`studentId`, `batchId`),
    INDEX `BatchCertificate_batchId_idx`(`batchId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BatchCertificate` ADD CONSTRAINT `BatchCertificate_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `BatchCertificate` ADD CONSTRAINT `BatchCertificate_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `Batch`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `BatchCertificate` ADD CONSTRAINT `BatchCertificate_generatedById_fkey` FOREIGN KEY (`generatedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
