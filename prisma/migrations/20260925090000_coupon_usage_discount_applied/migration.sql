-- Supports stacking up to 3 coupons on one admission: each coupon now
-- records its own contribution to the discount (CouponUsage.discountApplied),
-- while FeePaymentPlan.couponDiscount stays as the combined total.
ALTER TABLE `CouponUsage` ADD COLUMN `discountApplied` DOUBLE NOT NULL DEFAULT 0;
