-- Admission module (Phase 1) — reuses Lead/FeePaymentPlan/FeeInstallment/
-- AcademyCourse/Batch/BatchCourseSchedule/Student rather than duplicating
-- master data. FeePaymentPlan becomes the Admission record; new tables are
-- only the genuinely-new pieces: course-fee master, coupons, and the single
-- tunable-rules row (AdmissionConfig).

-- AlterEnum: ModuleName — add ADMISSION
ALTER TABLE `DepartmentModuleAccess`
  MODIFY COLUMN `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING', 'CERTIFICATES', 'STUDENT_ONBOARDING', 'ADMISSION') NOT NULL;
ALTER TABLE `UserModuleAccess`
  MODIFY COLUMN `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING', 'CERTIFICATES', 'STUDENT_ONBOARDING', 'ADMISSION') NOT NULL;

-- AlterEnum: StudentTrack — add JRP_RECORDED, ELITE (Admission-only tracks)
ALTER TABLE `Student`
  MODIFY COLUMN `track` ENUM('JRP_RECORDED', 'JRP', 'IOP', 'PAP', 'PT', 'ELITE') NOT NULL DEFAULT 'JRP';
-- KRAEntry.track was left behind when PT was added in an earlier migration
-- (still only JRP/IOP/PAP) — widening it here too so it doesn't drift
-- further out of sync with the Prisma-level StudentTrack type.
ALTER TABLE `KRAEntry`
  MODIFY COLUMN `track` ENUM('JRP_RECORDED', 'JRP', 'IOP', 'PAP', 'PT', 'ELITE') NULL;

-- AlterEnum: FeePlanType — add SPOT
ALTER TABLE `FeePaymentPlan`
  MODIFY COLUMN `planType` ENUM('SPOT', 'FULL', 'PART', 'EMI') NOT NULL DEFAULT 'FULL';

-- AlterTable: FeeInstallment — what a row represents, for reporting
ALTER TABLE `FeeInstallment` ADD COLUMN `kind` ENUM('REGISTRATION_FEE', 'SPOT_PAYMENT', 'FULL_PAYMENT', 'DOWN_PAYMENT', 'EMI', 'ORIENTATION_BALANCE', 'FORECLOSURE') NULL;
ALTER TABLE `FeeInstallment` ADD COLUMN `emiMonthNumber` INT NULL;

-- AlterTable: FeePaymentPlan — Admission fields (all nullable; every
-- pre-existing plan row is left untouched)
ALTER TABLE `FeePaymentPlan` ADD COLUMN `admissionId` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `admissionStatus` ENUM('DRAFT', 'CONFIRMED', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'TRANSFERRED', 'REFUND_REQUESTED', 'REFUNDED') NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `courseId` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `track` ENUM('JRP_RECORDED', 'JRP', 'IOP', 'PAP', 'PT', 'ELITE') NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `scheduleId` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `batchAllocatedAt` DATETIME(3) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `couponId` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `couponDiscount` DOUBLE NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `paymentDiscountAmount` DOUBLE NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `registrationFee` DOUBLE NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `downPayment` DOUBLE NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `emiMonths` INT NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `interestRatePct` DOUBLE NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `salespersonLockedAt` DATETIME(3) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `foreclosedAt` DATETIME(3) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `foreclosedById` VARCHAR(191) NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `foreclosureAmount` DOUBLE NULL;
ALTER TABLE `FeePaymentPlan` ADD COLUMN `foreclosureReason` TEXT NULL;

-- CreateTable
CREATE TABLE `CourseTrackFee` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `track` ENUM('JRP_RECORDED', 'JRP', 'IOP', 'PAP', 'PT', 'ELITE') NOT NULL,
    `baseFee` DOUBLE NOT NULL,
    `effectiveDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CourseTrackFee_courseId_track_idx`(`courseId`, `track`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Coupon` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `discountType` ENUM('FIXED', 'PERCENTAGE') NOT NULL,
    `discountValue` DOUBLE NOT NULL,
    `courseId` VARCHAR(191) NULL,
    `track` ENUM('JRP_RECORDED', 'JRP', 'IOP', 'PAP', 'PT', 'ELITE') NULL,
    `scheduleId` VARCHAR(191) NULL,
    `validFrom` DATETIME(3) NOT NULL,
    `validUntil` DATETIME(3) NOT NULL,
    `maxUsage` INT NULL,
    `perSalespersonUsageLimit` INT NULL,
    `minimumFee` DOUBLE NULL,
    `maximumDiscount` DOUBLE NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Coupon_code_key`(`code`),
    INDEX `Coupon_code_idx`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CouponUsage` (
    `id` VARCHAR(191) NOT NULL,
    `couponId` VARCHAR(191) NOT NULL,
    `admissionId` VARCHAR(191) NOT NULL,
    `salespersonId` VARCHAR(191) NULL,
    `usedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CouponUsage_couponId_idx`(`couponId`),
    INDEX `CouponUsage_salespersonId_idx`(`salespersonId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdmissionConfig` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'default',
    `spotDiscountPct` DOUBLE NOT NULL DEFAULT 8,
    `fullDiscountPct` DOUBLE NOT NULL DEFAULT 5,
    `registrationFee` DOUBLE NOT NULL DEFAULT 3500,
    `emiInterest3To4MonthPct` DOUBLE NOT NULL DEFAULT 7,
    `emiInterest5PlusMonthPct` DOUBLE NOT NULL DEFAULT 10,
    `downPaymentPct` DOUBLE NOT NULL DEFAULT 20,
    `portalApprovalMinPaidPct` DOUBLE NOT NULL DEFAULT 60,
    `trackEmiMonthLimits` JSON NOT NULL,
    `foreclosureBeforeFirstEmiPolicy` VARCHAR(191) NOT NULL DEFAULT 'NO_INTEREST',
    `foreclosureAfterFirstEmiPolicy` VARCHAR(191) NOT NULL DEFAULT 'FULL_INTEREST',
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `FeePaymentPlan_admissionId_key` ON `FeePaymentPlan`(`admissionId`);
CREATE INDEX `FeePaymentPlan_admissionId_idx` ON `FeePaymentPlan`(`admissionId`);
CREATE INDEX `FeePaymentPlan_scheduleId_idx` ON `FeePaymentPlan`(`scheduleId`);
CREATE INDEX `FeePaymentPlan_courseId_idx` ON `FeePaymentPlan`(`courseId`);

-- AddForeignKey
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `Coupon`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `FeePaymentPlan` ADD CONSTRAINT `FeePaymentPlan_foreclosedById_fkey` FOREIGN KEY (`foreclosedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CourseTrackFee` ADD CONSTRAINT `CourseTrackFee_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CourseTrackFee` ADD CONSTRAINT `CourseTrackFee_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Coupon` ADD CONSTRAINT `Coupon_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Coupon` ADD CONSTRAINT `Coupon_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `Coupon` ADD CONSTRAINT `Coupon_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `CouponUsage` ADD CONSTRAINT `CouponUsage_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `Coupon`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CouponUsage` ADD CONSTRAINT `CouponUsage_admissionId_fkey` FOREIGN KEY (`admissionId`) REFERENCES `FeePaymentPlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CouponUsage` ADD CONSTRAINT `CouponUsage_salespersonId_fkey` FOREIGN KEY (`salespersonId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the single AdmissionConfig row with the rates confirmed for launch:
-- Spot 8% (same-day-as-registration full payment), Full 5% (full payment
-- any time before batch start), ₹3,500 registration fee, EMI interest
-- 7% (3-4 months) / 10% (5+ months), 20% down payment, and the new rule
-- that non-EMI admissions must have 60% paid before the student portal can
-- be approved. Per-track EMI month limits: JRP Recorded 3, JRP 3, IOP 5,
-- Elite 6, PT 3 (no admission spec given for PT — defaulted to 3, adjust
-- in Admin Config screen once built).
INSERT INTO `AdmissionConfig` (`id`, `trackEmiMonthLimits`, `updatedAt`)
VALUES ('default', '{"JRP_RECORDED":3,"JRP":3,"IOP":5,"ELITE":6,"PT":3}', CURRENT_TIMESTAMP(3));
