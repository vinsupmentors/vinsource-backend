-- Demo: full student intake at booking, booking number, reschedule reason,
-- and conducted-outcome tracking (proof photo, outcome, co-conducted rep).

ALTER TABLE `Demo`
  ADD COLUMN `bookingNumber` VARCHAR(191) NULL,
  ADD COLUMN `city` VARCHAR(191) NULL,
  ADD COLUMN `educationQualification` VARCHAR(191) NULL,
  ADD COLUMN `collegeName` VARCHAR(191) NULL,
  ADD COLUMN `passedOutYear` INT NULL,
  ADD COLUMN `currentStatus` VARCHAR(191) NULL,
  ADD COLUMN `courseEnquired` VARCHAR(191) NULL,
  ADD COLUMN `bookingComments` TEXT NULL,
  ADD COLUMN `rescheduleReason` TEXT NULL,
  ADD COLUMN `proofUrl` VARCHAR(191) NULL,
  ADD COLUMN `outcome` ENUM('NOT_INTERESTED', 'INTERESTED', 'FIFTY_FIFTY', 'NEED_FOLLOWUP') NULL,
  ADD COLUMN `coConductedById` VARCHAR(191) NULL;

-- Backfill demo rows that already exist (e.g. created via the legacy CRM bulk
-- import before this feature shipped) with a placeholder booking number that
-- can never collide with the DEMO-000001-style sequence new bookings get.
UPDATE `Demo` SET `bookingNumber` = CONCAT('DEMO-LEGACY-', UPPER(SUBSTRING(`id`, 1, 8))) WHERE `bookingNumber` IS NULL;

ALTER TABLE `Demo` MODIFY COLUMN `bookingNumber` VARCHAR(191) NOT NULL;
CREATE UNIQUE INDEX `Demo_bookingNumber_key` ON `Demo`(`bookingNumber`);

ALTER TABLE `Demo` ADD CONSTRAINT `Demo_coConductedById_fkey` FOREIGN KEY (`coConductedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
