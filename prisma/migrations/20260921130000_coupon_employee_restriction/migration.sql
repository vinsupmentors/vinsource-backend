-- Coupons can now be locked to one specific salesperson (e.g. a manager
-- approves a one-off flat discount that only that rep may apply).

-- AlterTable
ALTER TABLE `Coupon`
  ADD COLUMN `restrictedToEmployeeId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `Coupon`
  ADD CONSTRAINT `Coupon_restrictedToEmployeeId_fkey`
  FOREIGN KEY (`restrictedToEmployeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
