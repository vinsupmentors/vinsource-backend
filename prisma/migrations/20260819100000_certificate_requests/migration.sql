-- CreateTable
CREATE TABLE `StudentCertificateRequest` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `type` ENUM('COURSE_COMPLETION', 'INTERNSHIP') NOT NULL,
    `courseId` VARCHAR(191) NULL,
    `feeApprovedById` VARCHAR(191) NULL,
    `feeApprovedAt` DATETIME(3) NULL,
    `ldmApprovedById` VARCHAR(191) NULL,
    `ldmApprovedAt` DATETIME(3) NULL,
    `certificateNo` VARCHAR(191) NULL,
    `pdfUrl` VARCHAR(191) NULL,
    `generatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StudentCertificateRequest_certificateNo_key`(`certificateNo`),
    UNIQUE INDEX `StudentCertificateRequest_studentId_type_key`(`studentId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- AddForeignKey
ALTER TABLE `StudentCertificateRequest` ADD CONSTRAINT `StudentCertificateRequest_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentCertificateRequest` ADD CONSTRAINT `StudentCertificateRequest_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentCertificateRequest` ADD CONSTRAINT `StudentCertificateRequest_feeApprovedById_fkey` FOREIGN KEY (`feeApprovedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentCertificateRequest` ADD CONSTRAINT `StudentCertificateRequest_ldmApprovedById_fkey` FOREIGN KEY (`ldmApprovedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
