-- Admission module follow-up: per-mode seat capacity for Hybrid batches, and
-- which delivery mode a given admission was booked into. ONLINE-only /
-- OFFLINE-only schedules keep using `capacity` unchanged; only HYBRID
-- schedules use the two new split columns instead.

-- AlterTable
ALTER TABLE `BatchCourseSchedule`
  ADD COLUMN `onlineCapacity` INT NULL,
  ADD COLUMN `offlineCapacity` INT NULL;

-- AlterTable
ALTER TABLE `FeePaymentPlan`
  ADD COLUMN `deliveryMode` ENUM('ONLINE', 'OFFLINE', 'HYBRID') NULL;
