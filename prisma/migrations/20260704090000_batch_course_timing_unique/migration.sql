-- Allow the same course to appear in a batch at different timings
-- (morning + evening sessions). Uniqueness is now batch + course + timing.
DROP INDEX `BatchCourseSchedule_batchId_courseId_key` ON `BatchCourseSchedule`;
CREATE UNIQUE INDEX `BatchCourseSchedule_batchId_courseId_timing_key` ON `BatchCourseSchedule`(`batchId`, `courseId`, `timing`);
