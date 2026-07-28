-- Student intake fields move from Demo-booking time to call-logging time:
-- captured once on the Lead as soon as known, then copied onto each Demo
-- row automatically when a demo is scheduled for that lead.
ALTER TABLE `Lead`
  ADD COLUMN `city` VARCHAR(191) NULL,
  ADD COLUMN `educationQualification` VARCHAR(191) NULL,
  ADD COLUMN `collegeName` VARCHAR(191) NULL,
  ADD COLUMN `passedOutYear` INT NULL,
  ADD COLUMN `currentStatus` VARCHAR(191) NULL;
