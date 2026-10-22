-- Project presentation proof on trainer feedback
ALTER TABLE `TrainerFeedback`
  ADD COLUMN `presentationDone` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `presentationAt` DATETIME(3) NULL,
  ADD COLUMN `presentationPhotos` JSON NULL,
  ADD COLUMN `presentationMarkedById` VARCHAR(191) NULL;

-- Grandfather students who were already moved forward before this rule existed:
-- trainers have no presentation photos for them, so they count as presentation-done (no photos).
UPDATE `TrainerFeedback` tf
LEFT JOIN `Student` s ON s.id = tf.studentId
SET tf.presentationDone = true
WHERE tf.certificateEligible = true
   OR tf.jrpToIopRecommended = true
   OR s.status IN ('IN_PLACEMENT', 'PLACED', 'COMPLETED');
