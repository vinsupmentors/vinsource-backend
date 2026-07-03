-- Human-friendly unique code per sub-batch (BatchCourseSchedule).
ALTER TABLE `BatchCourseSchedule` ADD COLUMN `code` VARCHAR(191) NULL;

-- Backfill existing sub-batches with a stable short code derived from the id.
UPDATE `BatchCourseSchedule` SET `code` = CONCAT('SB-', UPPER(SUBSTRING(`id`, 1, 8))) WHERE `code` IS NULL;

CREATE UNIQUE INDEX `BatchCourseSchedule_code_key` ON `BatchCourseSchedule`(`code`);
