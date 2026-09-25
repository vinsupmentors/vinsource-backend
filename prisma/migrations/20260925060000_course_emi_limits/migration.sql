-- Per-course EMI month-limit override. Null means "use the global
-- AdmissionConfig.trackEmiMonthLimits value for this track" — only courses
-- that need a different cap for a specific track (e.g. Dataverse's IOP
-- track allowing 6 months instead of the usual 5) need this set.
ALTER TABLE `AcademyCourse` ADD COLUMN `emiMonthLimits` JSON NULL;
