-- CreateTable
CREATE TABLE `CourseMaterial` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `type` ENUM('FILE', 'LINK', 'VIDEO') NOT NULL DEFAULT 'FILE',
    `url` VARCHAR(191) NOT NULL,
    `notes` VARCHAR(191) NULL,
    `uploadedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CourseMaterial` ADD CONSTRAINT `CourseMaterial_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `CourseMaterial` ADD CONSTRAINT `CourseMaterial_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `AcademyModule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `CourseMaterial` ADD CONSTRAINT `CourseMaterial_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
