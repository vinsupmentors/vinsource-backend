-- Lets an admin send a student's onboarding back for correction from the
-- Approval screen: reopens the profile step without touching documents
-- already signed.

ALTER TABLE `Student` ADD COLUMN `rejectionReason` TEXT NULL;
ALTER TABLE `Student` ADD COLUMN `onboardingRejectedAt` DATETIME(3) NULL;
ALTER TABLE `Student` ADD COLUMN `onboardingRejectedById` VARCHAR(191) NULL;

ALTER TABLE `Student` ADD CONSTRAINT `Student_onboardingRejectedById_fkey` FOREIGN KEY (`onboardingRejectedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
