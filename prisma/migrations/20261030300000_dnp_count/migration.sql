-- Consecutive DNP (did not pick) updates per lead; 5 in a row moves the lead to Unresponsive.
ALTER TABLE `Lead` ADD COLUMN `dnpCount` INTEGER NOT NULL DEFAULT 0;
UPDATE `Lead` SET `dnpCount` = 1 WHERE `activityStatus` = 'DNP';
