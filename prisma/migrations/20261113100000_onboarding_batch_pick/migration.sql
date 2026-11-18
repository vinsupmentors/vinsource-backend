-- Production marks which sub-batches Sales may onboard leads into.
ALTER TABLE `BatchCourseSchedule` ADD COLUMN `openForOnboarding` BOOLEAN NOT NULL DEFAULT false;

-- The sub-batch Sales picked when onboarding a lead.
ALTER TABLE `LeadOnboarding` ADD COLUMN `scheduleId` VARCHAR(191) NULL;
