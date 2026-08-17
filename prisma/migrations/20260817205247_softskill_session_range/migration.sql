-- Softskill/Aptitude sessions can now span a date range (a multi-day training
-- program with one attendance mark for the whole thing), and get a third,
-- combined "SK_APT" type.

ALTER TABLE `SoftskillSession`
  MODIFY COLUMN `type` ENUM('SOFTSKILL', 'APTITUDE', 'SK_APT') NOT NULL;

ALTER TABLE `SoftskillSession`
  CHANGE COLUMN `sessionDate` `startDate` DATETIME(3) NOT NULL;

ALTER TABLE `SoftskillSession`
  ADD COLUMN `endDate` DATETIME(3) NULL;
