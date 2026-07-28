-- Student Onboarding: reusable signed-document templates + per-student
-- signature records, plus a new grantable module for Master Control.

ALTER TABLE `DepartmentModuleAccess` MODIFY COLUMN `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING', 'CERTIFICATES', 'STUDENT_ONBOARDING') NOT NULL;
ALTER TABLE `UserModuleAccess` MODIFY COLUMN `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING', 'CERTIFICATES', 'STUDENT_ONBOARDING') NOT NULL;

ALTER TABLE `Student` ADD COLUMN `documentsCompletedAt` DATETIME(3) NULL;

CREATE TABLE `OnboardingDocumentTemplate` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `fileKey` VARCHAR(191) NOT NULL,
  `fileUrl` VARCHAR(191) NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `order` INTEGER NOT NULL DEFAULT 0,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `StudentDocumentSignature` (
  `id` VARCHAR(191) NOT NULL,
  `studentId` VARCHAR(191) NOT NULL,
  `templateId` VARCHAR(191) NOT NULL,
  `signatureUrl` VARCHAR(191) NOT NULL,
  `photoUrl` VARCHAR(191) NOT NULL,
  `ipAddress` VARCHAR(191) NULL,
  `location` VARCHAR(191) NULL,
  `signedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `StudentDocumentSignature_studentId_templateId_key`(`studentId`, `templateId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `StudentDocumentSignature_studentId_templateId_key` ON `StudentDocumentSignature`(`studentId`, `templateId`);

ALTER TABLE `OnboardingDocumentTemplate` ADD CONSTRAINT `OnboardingDocumentTemplate_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `StudentDocumentSignature` ADD CONSTRAINT `StudentDocumentSignature_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `StudentDocumentSignature` ADD CONSTRAINT `StudentDocumentSignature_templateId_fkey` FOREIGN KEY (`templateId`) REFERENCES `OnboardingDocumentTemplate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Grandfather every student who already finished onboarding before this
-- feature existed — otherwise they'd get bounced back to complete-profile
-- (now requiring signed documents) despite already having full portal
-- access today. Only students who complete their profile *after* this
-- migration will ever be asked to sign anything.
UPDATE `Student` SET `documentsCompletedAt` = NOW() WHERE `profileCompletedAt` IS NOT NULL;
