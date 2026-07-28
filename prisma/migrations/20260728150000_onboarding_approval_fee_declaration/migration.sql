-- Track-scoped onboarding documents, per-student fee declarations, and a
-- final admin approval gate before a student's dashboard unlocks.

ALTER TABLE `OnboardingDocumentTemplate` ADD COLUMN `applicableTracks` JSON NULL;

ALTER TABLE `Student` ADD COLUMN `onboardingApprovedAt` DATETIME(3) NULL;
ALTER TABLE `Student` ADD COLUMN `onboardingApprovedById` VARCHAR(191) NULL;

CREATE TABLE `StudentFeeDeclaration` (
  `id` VARCHAR(191) NOT NULL,
  `studentId` VARCHAR(191) NOT NULL,
  `guardianName` VARCHAR(191) NULL,
  `courseName` VARCHAR(191) NULL,
  `dueDate` DATETIME(3) NULL,
  `rows` JSON NOT NULL,
  `signatureUrl` VARCHAR(191) NULL,
  `photoUrl` VARCHAR(191) NULL,
  `ipAddress` VARCHAR(191) NULL,
  `location` VARCHAR(191) NULL,
  `signedAt` DATETIME(3) NULL,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Student` ADD CONSTRAINT `Student_onboardingApprovedById_fkey` FOREIGN KEY (`onboardingApprovedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `StudentFeeDeclaration` ADD CONSTRAINT `StudentFeeDeclaration_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `StudentFeeDeclaration` ADD CONSTRAINT `StudentFeeDeclaration_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Grandfather every student who already finished onboarding (documents
-- signed) before this approval gate existed — otherwise they'd suddenly be
-- blocked from their dashboard by a step that didn't exist when they
-- onboarded. Only students who finish signing *after* this migration will
-- ever need to wait on this new approval.
UPDATE `Student` SET `onboardingApprovedAt` = COALESCE(`documentsCompletedAt`, NOW()) WHERE `documentsCompletedAt` IS NOT NULL;
