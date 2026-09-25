-- Replace the old two-bucket EMI interest config (3-4 months / 5+ months)
-- with a per-exact-month-tenure table, matching the new interest slab
-- Gaurav provided (2M:3%, 3M:5%, 4M:7%, 5M:10%, 6M:10%). Interest is now
-- calculated on the financed balance (post-down-payment), not the full fee
-- -- see admissionFeeEngine.ts.
ALTER TABLE `AdmissionConfig` DROP COLUMN `emiInterest3To4MonthPct`;
ALTER TABLE `AdmissionConfig` DROP COLUMN `emiInterest5PlusMonthPct`;
ALTER TABLE `AdmissionConfig` ADD COLUMN `emiInterestByMonth` JSON NULL;
UPDATE `AdmissionConfig` SET `emiInterestByMonth` = JSON_OBJECT('2', 3, '3', 5, '4', 7, '5', 10, '6', 10) WHERE `id` = 'default';
ALTER TABLE `AdmissionConfig` MODIFY COLUMN `emiInterestByMonth` JSON NOT NULL;
