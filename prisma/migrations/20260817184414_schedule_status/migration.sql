-- Sub-batches (BatchCourseSchedule) get their own status, independent of the
-- parent Batch, so a batch can only be completed once every course within it
-- actually is.

ALTER TABLE `BatchCourseSchedule`
  ADD COLUMN `status` ENUM('UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'UPCOMING';

-- Backfill: sub-batches under a Batch that's already marked COMPLETED today
-- should be COMPLETED too, so existing completed batches don't retroactively
-- fail the new completion-gate validation the next time they're saved.
UPDATE `BatchCourseSchedule` s
JOIN `Batch` b ON b.id = s.batchId
SET s.status = 'COMPLETED'
WHERE b.status = 'COMPLETED';
