-- Placement drives need a venue/location captured (on-site address or an
-- "Online"/meeting-link note for virtual drives) alongside the existing
-- driveDate — free text since venues vary too widely for a fixed enum.

-- AlterTable
ALTER TABLE `PlacementDrive`
  ADD COLUMN `venue` VARCHAR(191) NULL;
