-- Allow the same course to appear in a batch at different timings
-- (morning + evening sessions). Uniqueness is now batch + course + timing.
-- NOTE: create the new index BEFORE dropping the old one — the FK on batchId
-- needs an index starting with batchId at all times (MySQL error 1553 otherwise).
CREATE UNIQUE INDEX `BatchCourseSchedule_batchId_courseId_timing_key` ON `BatchCourseSchedule`(`batchId`, `courseId`, `timing`);
DROP INDEX `BatchCourseSchedule_batchId_courseId_key` ON `BatchCourseSchedule`;
