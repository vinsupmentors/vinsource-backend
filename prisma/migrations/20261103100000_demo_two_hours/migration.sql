ALTER TABLE `Demo` ALTER COLUMN `maxMinutes` SET DEFAULT 120;
UPDATE `Demo` SET `maxMinutes` = 120 WHERE `maxMinutes` = 60 AND `status` = 'SCHEDULED';
