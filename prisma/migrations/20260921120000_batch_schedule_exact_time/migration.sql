-- Batches now run more than one distinct slot per coarse timing bucket
-- (e.g. two separate "Morning" slots: 9:30-11:30 and 12:00-2:00), so
-- Admission's batch creator captures the exact clock range in addition to
-- the existing bucket. Nullable — every pre-existing schedule keeps working
-- unchanged and just has no exact time recorded.

-- AlterTable
ALTER TABLE `BatchCourseSchedule`
  ADD COLUMN `startTime` VARCHAR(191) NULL,
  ADD COLUMN `endTime` VARCHAR(191) NULL;
