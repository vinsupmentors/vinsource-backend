-- Portal-hosted online demo room (60 min window, reopen needs Sales Admin approval)
ALTER TABLE `Demo`
  ADD COLUMN `roomName` VARCHAR(191) NULL,
  ADD COLUMN `accessCode` VARCHAR(191) NULL,
  ADD COLUMN `maxMinutes` INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN `startedAt` DATETIME(3) NULL,
  ADD COLUMN `expiresAt` DATETIME(3) NULL,
  ADD COLUMN `closedAt` DATETIME(3) NULL,
  ADD COLUMN `reopenCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `reopenRequestedAt` DATETIME(3) NULL,
  ADD COLUMN `reopenNote` TEXT NULL;

CREATE UNIQUE INDEX `Demo_roomName_key` ON `Demo`(`roomName`);
CREATE UNIQUE INDEX `Demo_accessCode_key` ON `Demo`(`accessCode`);
