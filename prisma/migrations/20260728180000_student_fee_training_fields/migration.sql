-- Fee/enrollment intake fields captured by admin when adding a new student in
-- Student Onboarding — Training Mode + fee details. Course Name / Batch No are
-- deliberately NOT here, since they're already derivable from the student's
-- StudentBatchEnrollment relation.

ALTER TABLE `Student` ADD COLUMN `trainingMode` VARCHAR(191) NULL;
ALTER TABLE `Student` ADD COLUMN `totalProgramFee` DOUBLE NULL;
ALTER TABLE `Student` ADD COLUMN `amountPaid` DOUBLE NULL;
ALTER TABLE `Student` ADD COLUMN `balanceAmount` DOUBLE NULL;
ALTER TABLE `Student` ADD COLUMN `paymentMode` VARCHAR(191) NULL;
