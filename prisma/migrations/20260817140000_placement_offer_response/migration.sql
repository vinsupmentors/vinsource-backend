-- Track whether the student actually accepted or declined a SELECTED offer,
-- and capture the company name for off-campus/direct offers (driveId null),
-- which previously had no way to record who the offer was actually from.

ALTER TABLE `PlacementResult`
  ADD COLUMN `offerStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `offerRespondedAt` DATETIME(3) NULL,
  ADD COLUMN `companyName` VARCHAR(191) NULL;
