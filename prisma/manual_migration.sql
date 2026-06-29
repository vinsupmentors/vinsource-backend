-- ============================================================
-- Manual migration — run this in MySQL Workbench or CLI
-- mysql -u hrms_user -p hrms < manual_migration.sql
-- ============================================================

USE hrms;

-- 1. Add WFH / IP tracking columns to Attendance (safe — skips if column already exists)
DROP PROCEDURE IF EXISTS hrms_migrate_attendance;
DELIMITER $$
CREATE PROCEDURE hrms_migrate_attendance()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='hrms' AND TABLE_NAME='Attendance' AND COLUMN_NAME='checkInIp') THEN
    ALTER TABLE `Attendance` ADD COLUMN `checkInIp` VARCHAR(45) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='hrms' AND TABLE_NAME='Attendance' AND COLUMN_NAME='checkOutIp') THEN
    ALTER TABLE `Attendance` ADD COLUMN `checkOutIp` VARCHAR(45) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='hrms' AND TABLE_NAME='Attendance' AND COLUMN_NAME='locationType') THEN
    ALTER TABLE `Attendance` ADD COLUMN `locationType` VARCHAR(20) NOT NULL DEFAULT 'OFFICE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='hrms' AND TABLE_NAME='Attendance' AND COLUMN_NAME='wfhStatus') THEN
    ALTER TABLE `Attendance` ADD COLUMN `wfhStatus` VARCHAR(20) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='hrms' AND TABLE_NAME='Attendance' AND COLUMN_NAME='wfhNote') THEN
    ALTER TABLE `Attendance` ADD COLUMN `wfhNote` TEXT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='hrms' AND TABLE_NAME='Attendance' AND COLUMN_NAME='wfhApprovedById') THEN
    ALTER TABLE `Attendance` ADD COLUMN `wfhApprovedById` VARCHAR(36) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='hrms' AND TABLE_NAME='Attendance' AND COLUMN_NAME='wfhApprovedAt') THEN
    ALTER TABLE `Attendance` ADD COLUMN `wfhApprovedAt` DATETIME(3) NULL;
  END IF;
END$$
DELIMITER ;
CALL hrms_migrate_attendance();
DROP PROCEDURE IF EXISTS hrms_migrate_attendance;

-- 2. Create PasswordLog table (plain-text audit — admin use only)
CREATE TABLE IF NOT EXISTS `PasswordLog` (
  `id`         VARCHAR(36)   NOT NULL,
  `userId`     VARCHAR(36)   NOT NULL,
  `plainText`  TEXT          NOT NULL,
  `setBy`      VARCHAR(36)   NULL,
  `reason`     VARCHAR(50)   NULL,
  `createdAt`  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `PasswordLog_userId_fkey` (`userId`),
  CONSTRAINT `PasswordLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Done
SELECT 'Migration applied successfully' AS result;
