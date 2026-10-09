-- Trainer marks classes completed -> project phase, with a mandatory presentation date.
ALTER TABLE `BatchCourseSchedule`
  ADD COLUMN `classesCompletedAt` DATETIME(3) NULL,
  ADD COLUMN `projectPresentationDate` DATETIME(3) NULL;
