-- AlterTable
ALTER TABLE `attendance` ADD COLUMN `checkInIp` VARCHAR(191) NULL,
    ADD COLUMN `checkOutIp` VARCHAR(191) NULL,
    ADD COLUMN `locationType` VARCHAR(191) NOT NULL DEFAULT 'OFFICE',
    ADD COLUMN `wfhApprovedAt` DATETIME(3) NULL,
    ADD COLUMN `wfhApprovedById` VARCHAR(191) NULL,
    ADD COLUMN `wfhNote` VARCHAR(191) NULL,
    ADD COLUMN `wfhStatus` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `document` ADD COLUMN `isOriginalSubmitted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `submittedAt` DATETIME(3) NULL,
    MODIFY `type` ENUM('RESUME', 'AADHAAR', 'PAN', 'PASSPORT', 'DEGREE', 'DEGREE_PG', 'MARKSHEET_10', 'MARKSHEET_12', 'PAYSLIP', 'OFFER_LETTER', 'CONTRACT', 'SALARY_REVISION', 'OTHER') NOT NULL;

-- AlterTable
ALTER TABLE `notification` MODIFY `type` ENUM('LEAVE_REQUEST', 'LEAVE_APPROVED', 'LEAVE_REJECTED', 'ATTENDANCE_CORRECTION', 'EXPENSE_CLAIM', 'NEW_EMPLOYEE', 'RESIGNATION', 'ONBOARDING_SUBMITTED', 'ONBOARDING_APPROVED', 'ONBOARDING_DOCUMENT_READY', 'RESIGNATION_SUBMITTED', 'RESIGNATION_APPROVED', 'EXIT_CLEARANCE_SUBMITTED', 'EXIT_CLEARANCE_COMPLETED', 'PAYROLL_GENERATED', 'DOCUMENT_EXPIRY', 'PERFORMANCE_REVIEW', 'TRAINING_ASSIGNED', 'BIRTHDAY', 'ANNIVERSARY', 'SYSTEM', 'PROJECT_RELEASED', 'FEEDBACK_FORM_RELEASED', 'TEST_ACTIVATED', 'DEADLINE_REMINDER', 'MODULE_FEEDBACK_GIVEN') NOT NULL;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `canManageAccess` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    MODIFY `role` ENUM('SUPER_ADMIN', 'ADMIN', 'HR', 'MANAGER', 'EMPLOYEE', 'STUDENT') NOT NULL DEFAULT 'EMPLOYEE';

-- CreateTable
CREATE TABLE `SalaryStructure` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `effectiveDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `netSalary` DOUBLE NOT NULL,
    `grossSalary` DOUBLE NOT NULL,
    `basic` DOUBLE NOT NULL,
    `hra` DOUBLE NOT NULL,
    `conveyance` DOUBLE NOT NULL DEFAULT 1600,
    `medicalAllowance` DOUBLE NOT NULL DEFAULT 1250,
    `specialAllowance` DOUBLE NOT NULL DEFAULT 0,
    `hasPf` BOOLEAN NOT NULL DEFAULT false,
    `pf` DOUBLE NOT NULL,
    `esi` DOUBLE NOT NULL DEFAULT 0,
    `professionalTax` DOUBLE NOT NULL DEFAULT 200,
    `tds` DOUBLE NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SalaryStructure_employeeId_key`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttendanceSession` (
    `id` VARCHAR(191) NOT NULL,
    `attendanceId` VARCHAR(191) NOT NULL,
    `checkIn` DATETIME(3) NOT NULL,
    `checkOut` DATETIME(3) NULL,
    `durationHours` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Permission` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `fromTime` VARCHAR(191) NOT NULL,
    `toTime` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'PERMISSION',
    `session` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `managerId` VARCHAR(191) NULL,
    `managerNote` VARCHAR(191) NULL,
    `actedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttendanceRegularization` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `requestedCheckIn` VARCHAR(191) NULL,
    `requestedCheckOut` VARCHAR(191) NULL,
    `requestedStatus` VARCHAR(191) NOT NULL DEFAULT 'PRESENT',
    `reason` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `managerId` VARCHAR(191) NULL,
    `managerNote` VARCHAR(191) NULL,
    `actedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CompOffRequest` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `workDate` DATE NOT NULL,
    `reason` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `managerId` VARCHAR(191) NULL,
    `managerNote` VARCHAR(191) NULL,
    `actedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DeadlineReminderLog` (
    `id` VARCHAR(191) NOT NULL,
    `releaseKind` ENUM('PROJECT', 'FEEDBACK_FORM', 'ONLINE_TEST') NOT NULL,
    `releaseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `daysBefore` INTEGER NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DeadlineReminderLog_releaseKind_releaseId_studentId_daysBefo_key`(`releaseKind`, `releaseId`, `studentId`, `daysBefore`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AttendanceEscalationLog` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `consecutiveDays` INTEGER NOT NULL,
    `asOfDate` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AttendanceEscalationLog_studentId_scheduleId_consecutiveDays_key`(`studentId`, `scheduleId`, `consecutiveDays`, `asOfDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DepartmentModuleAccess` (
    `id` VARCHAR(191) NOT NULL,
    `departmentId` VARCHAR(191) NOT NULL,
    `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING') NOT NULL,
    `accessLevel` ENUM('NONE', 'VIEW', 'EDIT', 'ADMIN') NOT NULL DEFAULT 'VIEW',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `DepartmentModuleAccess_departmentId_module_key`(`departmentId`, `module`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserModuleAccess` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `module` ENUM('SALES', 'FINANCE_SALES', 'FINANCE_ADMIN', 'ADMIN', 'HR', 'PRODUCTION_TRAINING', 'PLACEMENTS', 'DIGITAL_MARKETING') NOT NULL,
    `accessLevel` ENUM('NONE', 'VIEW', 'EDIT', 'ADMIN') NOT NULL DEFAULT 'VIEW',
    `grantedById` VARCHAR(191) NULL,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `UserModuleAccess_userId_module_key`(`userId`, `module`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Lead` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `source` VARCHAR(191) NULL,
    `courseInterest` VARCHAR(191) NULL,
    `status` ENUM('NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'DEMO_DONE', 'NEGOTIATION', 'ENROLLED', 'LOST') NOT NULL DEFAULT 'NEW',
    `assignedToId` VARCHAR(191) NULL,
    `campaignId` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Demo` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `scheduledAt` DATETIME(3) NOT NULL,
    `conductedById` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'SCHEDULED',
    `feedback` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeeCollection` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NULL,
    `studentName` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `mode` ENUM('CASH', 'UPI', 'CARD', 'NET_BANKING', 'CHEQUE', 'OTHER') NOT NULL DEFAULT 'UPI',
    `receivedById` VARCHAR(191) NULL,
    `receiptNo` VARCHAR(191) NULL,
    `remarks` VARCHAR(191) NULL,
    `collectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FeeCollection_receiptNo_key`(`receiptNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminExpense` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NULL,
    `miscDescription` VARCHAR(191) NULL,
    `amount` DOUBLE NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'PAID') NOT NULL DEFAULT 'PENDING',
    `voucherNo` VARCHAR(191) NULL,
    `billNo` VARCHAR(191) NULL,
    `paymentMode` VARCHAR(191) NULL,
    `billCopyUrl` VARCHAR(191) NULL,
    `paymentProofUrl` VARCHAR(191) NULL,
    `expenseDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `requestedById` VARCHAR(191) NULL,
    `approvedById` VARCHAR(191) NULL,
    `vendorId` VARCHAR(191) NULL,
    `recurringTemplateId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HOFundReceipt` (
    `id` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `receivedDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `notes` TEXT NULL,
    `recordedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Vendor` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `contactPerson` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `gstNumber` VARCHAR(191) NULL,
    `panNumber` VARCHAR(191) NULL,
    `category` VARCHAR(191) NULL,
    `bankName` VARCHAR(191) NULL,
    `bankAccountNo` VARCHAR(191) NULL,
    `ifscCode` VARCHAR(191) NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `notes` TEXT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RecurringExpenseTemplate` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NULL,
    `amount` DOUBLE NOT NULL,
    `vendorId` VARCHAR(191) NULL,
    `paymentMode` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Student` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NULL,
    `leadId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `studentCode` VARCHAR(191) NOT NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NOT NULL,
    `photo` VARCHAR(191) NULL,
    `track` ENUM('JRP', 'IOP', 'PAP') NOT NULL DEFAULT 'JRP',
    `status` ENUM('ENROLLED', 'ONBOARDED', 'ACTIVE', 'INACTIVE', 'COMPLETED', 'IN_PLACEMENT', 'PLACED', 'BATCH_TRANSFER') NOT NULL DEFAULT 'ENROLLED',
    `joiningDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `movedToPlacementAt` DATETIME(3) NULL,
    `dateOfBirth` DATETIME(3) NULL,
    `gender` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `city` VARCHAR(191) NULL,
    `state` VARCHAR(191) NULL,
    `pincode` VARCHAR(191) NULL,
    `emergencyContactName` VARCHAR(191) NULL,
    `emergencyContactPhone` VARCHAR(191) NULL,
    `education` JSON NULL,
    `aadharNumber` VARCHAR(191) NULL,
    `aadharPhoto` VARCHAR(191) NULL,
    `fatherName` VARCHAR(191) NULL,
    `fatherPhone` VARCHAR(191) NULL,
    `motherName` VARCHAR(191) NULL,
    `motherPhone` VARCHAR(191) NULL,
    `profileCompletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Student_userId_key`(`userId`),
    UNIQUE INDEX `Student_studentCode_key`(`studentCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AcademyCourse` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `totalHours` INTEGER NULL,
    `isCustom` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AcademyCourse_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AcademyModule` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `hours` INTEGER NULL,
    `dayRange` VARCHAR(191) NULL,
    `topics` TEXT NULL,

    UNIQUE INDEX `AcademyModule_courseId_order_key`(`courseId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Batch` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `startDate` DATETIME(3) NOT NULL,
    `endDate` DATETIME(3) NULL,
    `status` ENUM('UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'UPCOMING',
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Batch_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BatchCourseSchedule` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `timing` ENUM('MORNING', 'AFTERNOON', 'EVENING') NOT NULL,
    `dayPattern` ENUM('MON_SAT', 'SAT_SUN', 'SUNDAY_ONLY') NOT NULL,
    `mode` ENUM('ONLINE', 'OFFLINE', 'HYBRID') NOT NULL,
    `startDate` DATETIME(3) NOT NULL,
    `endDate` DATETIME(3) NULL,
    `capacity` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `BatchCourseSchedule_batchId_courseId_key`(`batchId`, `courseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainerAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `trainerId` VARCHAR(191) NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TrainerAssignment_scheduleId_trainerId_key`(`scheduleId`, `trainerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StudentBatchEnrollment` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'COMPLETED', 'DROPPED', 'ON_HOLD') NOT NULL DEFAULT 'ACTIVE',
    `enrolledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `StudentBatchEnrollment_studentId_scheduleId_key`(`studentId`, `scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StudentAttendance` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `status` ENUM('PRESENT', 'ABSENT', 'LATE') NOT NULL DEFAULT 'PRESENT',
    `markedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `StudentAttendance_studentId_scheduleId_date_key`(`studentId`, `scheduleId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `KRAEntry` (
    `id` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NULL,
    `trainerId` VARCHAR(191) NULL,
    `track` ENUM('JRP', 'IOP', 'PAP') NULL,
    `date` DATETIME(3) NOT NULL,
    `topicsCovered` TEXT NOT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `KRAEntry_scheduleId_track_date_moduleId_key`(`scheduleId`, `track`, `date`, `moduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModuleTest` (
    `id` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `testDate` DATETIME(3) NOT NULL,
    `maxMarks` INTEGER NOT NULL DEFAULT 100,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModuleMark` (
    `id` VARCHAR(191) NOT NULL,
    `testId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `marksObtained` DOUBLE NOT NULL,
    `remarks` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ModuleMark_testId_studentId_key`(`testId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModuleFeedback` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `trainerId` VARCHAR(191) NULL,
    `rating` INTEGER NULL,
    `comments` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ModuleFeedback_studentId_moduleId_scheduleId_key`(`studentId`, `moduleId`, `scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainerFeedback` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `trainerId` VARCHAR(191) NULL,
    `performanceRating` INTEGER NULL,
    `placementReadinessNote` TEXT NULL,
    `jrpToIopRecommended` BOOLEAN NULL,
    `certificateEligible` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TrainerFeedback_studentId_courseId_key`(`studentId`, `courseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CourseFeedback` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `trainerRating` INTEGER NULL,
    `contentRating` INTEGER NULL,
    `comments` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CourseFeedback_studentId_scheduleId_key`(`studentId`, `scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Referral` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `courseInterest` VARCHAR(191) NULL,
    `status` ENUM('NEW', 'CONTACTED', 'ENROLLED', 'NOT_INTERESTED') NOT NULL DEFAULT 'NEW',
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReportRecipient` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('DAILY_ATTENDANCE', 'ESCALATION') NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReportRecipient_type_email_key`(`type`, `email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Certificate` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `certificateNo` VARCHAR(191) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Certificate_certificateNo_key`(`certificateNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HiringPartner` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `industry` VARCHAR(191) NULL,
    `contactName` VARCHAR(191) NULL,
    `contactEmail` VARCHAR(191) NULL,
    `contactPhone` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementDrive` (
    `id` VARCHAR(191) NOT NULL,
    `partnerId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `driveDate` DATETIME(3) NOT NULL,
    `status` ENUM('SCHEDULED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
    `organizedById` VARCHAR(191) NULL,
    `notes` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementResult` (
    `id` VARCHAR(191) NOT NULL,
    `driveId` VARCHAR(191) NULL,
    `studentId` VARCHAR(191) NULL,
    `studentName` VARCHAR(191) NOT NULL,
    `result` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `package` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `designation` VARCHAR(191) NULL,
    `joiningDate` DATETIME(3) NULL,
    `offerLetterUrl` VARCHAR(191) NULL,
    `offerSentAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementInterview` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `driveId` VARCHAR(191) NULL,
    `companyName` VARCHAR(191) NULL,
    `round` INTEGER NOT NULL DEFAULT 1,
    `interviewerName` VARCHAR(191) NULL,
    `scheduledAt` DATETIME(3) NOT NULL,
    `outcome` ENUM('SCHEDULED', 'SELECTED', 'REJECTED', 'NO_SHOW', 'PENDING') NOT NULL DEFAULT 'SCHEDULED',
    `notes` TEXT NULL,
    `rating` DOUBLE NULL,
    `feedback` TEXT NULL,
    `feedbackGivenById` VARCHAR(191) NULL,
    `feedbackGivenAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlacementDriveCandidate` (
    `id` VARCHAR(191) NOT NULL,
    `driveId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `status` ENUM('SHORTLISTED', 'CONFIRMED', 'WITHDRAWN', 'REJECTED') NOT NULL DEFAULT 'SHORTLISTED',
    `addedById` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PlacementDriveCandidate_driveId_studentId_key`(`driveId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SoftskillSession` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('SOFTSKILL', 'APTITUDE') NOT NULL,
    `topic` VARCHAR(191) NOT NULL,
    `sessionDate` DATETIME(3) NOT NULL,
    `trainerId` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SoftskillAttendance` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `present` BOOLEAN NOT NULL DEFAULT true,
    `score` DOUBLE NULL,
    `remarks` TEXT NULL,

    UNIQUE INDEX `SoftskillAttendance_sessionId_studentId_key`(`sessionId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Campaign` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(191) NULL,
    `status` ENUM('PLANNED', 'ACTIVE', 'PAUSED', 'COMPLETED') NOT NULL DEFAULT 'PLANNED',
    `budget` DOUBLE NULL,
    `spent` DOUBLE NULL DEFAULT 0,
    `startDate` DATETIME(3) NULL,
    `endDate` DATETIME(3) NULL,
    `ownerId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `closedById` VARCHAR(191) NULL,
    `closureSummary` TEXT NULL,
    `closureExpenseSheetUrl` VARCHAR(191) NULL,
    `closureDashboardUrl` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampaignRecharge` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `rechargedFor` VARCHAR(191) NULL,
    `billUrl` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `rechargedById` VARCHAR(191) NULL,
    `rechargedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CampaignDailyReport` (
    `id` VARCHAR(191) NOT NULL,
    `campaignId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL,
    `leadsReceived` INTEGER NOT NULL DEFAULT 0,
    `leadsGivenToSales` INTEGER NOT NULL DEFAULT 0,
    `leadsUploadedToCrm` INTEGER NOT NULL DEFAULT 0,
    `amountSpent` DOUBLE NOT NULL DEFAULT 0,
    `dashboardUrl` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `reportedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `CampaignDailyReport_campaignId_date_key`(`campaignId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PasswordLog` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `plainText` VARCHAR(191) NOT NULL,
    `setBy` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OnboardingRequest` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `branchId` VARCHAR(191) NULL,
    `departmentId` VARCHAR(191) NULL,
    `designationId` VARCHAR(191) NULL,
    `managerId` VARCHAR(191) NULL,
    `firstName` VARCHAR(191) NOT NULL,
    `lastName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `gender` ENUM('MALE', 'FEMALE', 'OTHER') NULL,
    `joiningDate` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'ACCOUNT_CREATED', 'PROFILE_COMPLETE', 'AWAITING_APPROVAL', 'COMPLETED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `hrApprovedById` VARCHAR(191) NULL,
    `hrApprovedAt` DATETIME(3) NULL,
    `hrRemarks` VARCHAR(191) NULL,
    `rejectionReason` VARCHAR(191) NULL,
    `employeeId` VARCHAR(191) NULL,
    `tempPassword` VARCHAR(191) NULL,
    `firstLoginAt` DATETIME(3) NULL,
    `profileCompletedAt` DATETIME(3) NULL,
    `documentDeadline` DATETIME(3) NULL,
    `documentsSubmittedAt` DATETIME(3) NULL,
    `policyAgreedAt` DATETIME(3) NULL,
    `documentsSignedAt` DATETIME(3) NULL,
    `originalDocsConfirmedAt` DATETIME(3) NULL,
    `signatureName` VARCHAR(191) NULL,
    `hrFinalApprovedById` VARCHAR(191) NULL,
    `hrFinalApprovedAt` DATETIME(3) NULL,
    `hrFinalRemarks` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OnboardingRequest_employeeId_key`(`employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OnboardingDocument` (
    `id` VARCHAR(191) NOT NULL,
    `onboardingId` VARCHAR(191) NOT NULL,
    `documentName` VARCHAR(191) NOT NULL,
    `documentType` VARCHAR(191) NOT NULL,
    `fileKey` VARCHAR(191) NULL,
    `signedAt` DATETIME(3) NULL,
    `signedByName` VARCHAR(191) NULL,
    `signedByEmail` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'SIGNED', 'DECLINED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ResignationRequest` (
    `id` VARCHAR(191) NOT NULL,
    `employeeId` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `requestedLastDate` DATETIME(3) NOT NULL,
    `noticePeriodDays` INTEGER NOT NULL DEFAULT 30,
    `managerId` VARCHAR(191) NULL,
    `managerStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `managerApprovedById` VARCHAR(191) NULL,
    `managerApprovedAt` DATETIME(3) NULL,
    `managerLastDate` DATETIME(3) NULL,
    `managerRemarks` VARCHAR(191) NULL,
    `hrStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `hrApprovedById` VARCHAR(191) NULL,
    `hrApprovedAt` DATETIME(3) NULL,
    `hrLastDate` DATETIME(3) NULL,
    `hrRemarks` VARCHAR(191) NULL,
    `finalLastDate` DATETIME(3) NULL,
    `status` ENUM('PENDING', 'MANAGER_APPROVED', 'HR_APPROVED', 'BOTH_APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExitClearance` (
    `id` VARCHAR(191) NOT NULL,
    `resignationId` VARCHAR(191) NOT NULL,
    `initiatedById` VARCHAR(191) NOT NULL,
    `managerStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `managerApprovedById` VARCHAR(191) NULL,
    `managerApprovedAt` DATETIME(3) NULL,
    `managerRemarks` VARCHAR(191) NULL,
    `managerNewLastDate` DATETIME(3) NULL,
    `hrStatus` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `hrApprovedById` VARCHAR(191) NULL,
    `hrApprovedAt` DATETIME(3) NULL,
    `hrRemarks` VARCHAR(191) NULL,
    `hrNewLastDate` DATETIME(3) NULL,
    `status` ENUM('PENDING', 'MANAGER_CLEARED', 'HR_CLEARED', 'COMPLETED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `finalLastDate` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExitClearance_resignationId_key`(`resignationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExitDocument` (
    `id` VARCHAR(191) NOT NULL,
    `exitClearanceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `isReceived` BOOLEAN NOT NULL DEFAULT false,
    `receivedAt` DATETIME(3) NULL,
    `receivedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Project` (
    `id` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `resourceUrl` VARCHAR(191) NOT NULL,
    `isCapstone` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectRelease` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `releasedById` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `releasedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadline` DATETIME(3) NULL,

    UNIQUE INDEX `ProjectRelease_projectId_scheduleId_key`(`projectId`, `scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProjectSubmission` (
    `id` VARCHAR(191) NOT NULL,
    `releaseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `fileUrl` VARCHAR(191) NULL,
    `linkUrl` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `status` ENUM('SUBMITTED', 'REVIEWED') NOT NULL DEFAULT 'SUBMITTED',
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewNote` TEXT NULL,
    `grade` DOUBLE NULL,
    `maxGrade` DOUBLE NULL DEFAULT 100,

    UNIQUE INDEX `ProjectSubmission_releaseId_studentId_key`(`releaseId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeedbackForm` (
    `id` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `FeedbackForm_moduleId_key`(`moduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeedbackFormQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `formId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `type` ENUM('RATING', 'TEXT', 'MCQ') NOT NULL,
    `prompt` TEXT NOT NULL,
    `options` JSON NULL,
    `required` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `FeedbackFormQuestion_formId_order_key`(`formId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeedbackFormRelease` (
    `id` VARCHAR(191) NOT NULL,
    `formId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `releasedById` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `releasedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadline` DATETIME(3) NULL,

    UNIQUE INDEX `FeedbackFormRelease_formId_scheduleId_key`(`formId`, `scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeedbackFormResponse` (
    `id` VARCHAR(191) NOT NULL,
    `releaseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FeedbackFormResponse_releaseId_studentId_key`(`releaseId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FeedbackAnswer` (
    `id` VARCHAR(191) NOT NULL,
    `responseId` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `ratingValue` INTEGER NULL,
    `textValue` TEXT NULL,
    `optionValue` VARCHAR(191) NULL,

    UNIQUE INDEX `FeedbackAnswer_responseId_questionId_key`(`responseId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OnlineTest` (
    `id` VARCHAR(191) NOT NULL,
    `moduleId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `durationMinutes` INTEGER NOT NULL DEFAULT 45,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OnlineTestQuestion` (
    `id` VARCHAR(191) NOT NULL,
    `testId` VARCHAR(191) NOT NULL,
    `order` INTEGER NOT NULL,
    `prompt` TEXT NOT NULL,
    `options` JSON NOT NULL,
    `correctIndex` INTEGER NOT NULL,
    `marks` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `OnlineTestQuestion_testId_order_key`(`testId`, `order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OnlineTestRelease` (
    `id` VARCHAR(191) NOT NULL,
    `testId` VARCHAR(191) NOT NULL,
    `scheduleId` VARCHAR(191) NOT NULL,
    `activatedById` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `activatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadline` DATETIME(3) NULL,

    UNIQUE INDEX `OnlineTestRelease_testId_scheduleId_key`(`testId`, `scheduleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OnlineTestAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `releaseId` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deadlineAt` DATETIME(3) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `status` ENUM('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED_VIOLATION', 'EXPIRED') NOT NULL DEFAULT 'IN_PROGRESS',
    `score` INTEGER NULL,
    `totalMarks` INTEGER NULL,

    UNIQUE INDEX `OnlineTestAttempt_releaseId_studentId_key`(`releaseId`, `studentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OnlineTestAnswer` (
    `id` VARCHAR(191) NOT NULL,
    `attemptId` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `selectedIndex` INTEGER NULL,
    `isCorrect` BOOLEAN NULL,

    UNIQUE INDEX `OnlineTestAnswer_attemptId_questionId_key`(`attemptId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StudentPortfolio` (
    `id` VARCHAR(191) NOT NULL,
    `studentId` VARCHAR(191) NOT NULL,
    `summary` TEXT NULL,
    `education` JSON NULL,
    `skills` JSON NULL,
    `projects` JSON NULL,
    `experience` JSON NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `submittedAt` DATETIME(3) NULL,
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewNote` TEXT NULL,
    `publicSlug` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StudentPortfolio_studentId_key`(`studentId`),
    UNIQUE INDEX `StudentPortfolio_publicSlug_key`(`publicSlug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SalaryStructure` ADD CONSTRAINT `SalaryStructure_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttendanceSession` ADD CONSTRAINT `AttendanceSession_attendanceId_fkey` FOREIGN KEY (`attendanceId`) REFERENCES `Attendance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Permission` ADD CONSTRAINT `Permission_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Permission` ADD CONSTRAINT `Permission_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttendanceRegularization` ADD CONSTRAINT `AttendanceRegularization_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AttendanceRegularization` ADD CONSTRAINT `AttendanceRegularization_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CompOffRequest` ADD CONSTRAINT `CompOffRequest_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CompOffRequest` ADD CONSTRAINT `CompOffRequest_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DepartmentModuleAccess` ADD CONSTRAINT `DepartmentModuleAccess_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `Department`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserModuleAccess` ADD CONSTRAINT `UserModuleAccess_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserModuleAccess` ADD CONSTRAINT `UserModuleAccess_grantedById_fkey` FOREIGN KEY (`grantedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_assignedToId_fkey` FOREIGN KEY (`assignedToId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Lead` ADD CONSTRAINT `Lead_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Demo` ADD CONSTRAINT `Demo_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Demo` ADD CONSTRAINT `Demo_conductedById_fkey` FOREIGN KEY (`conductedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeeCollection` ADD CONSTRAINT `FeeCollection_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeeCollection` ADD CONSTRAINT `FeeCollection_receivedById_fkey` FOREIGN KEY (`receivedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminExpense` ADD CONSTRAINT `AdminExpense_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminExpense` ADD CONSTRAINT `AdminExpense_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminExpense` ADD CONSTRAINT `AdminExpense_vendorId_fkey` FOREIGN KEY (`vendorId`) REFERENCES `Vendor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AdminExpense` ADD CONSTRAINT `AdminExpense_recurringTemplateId_fkey` FOREIGN KEY (`recurringTemplateId`) REFERENCES `RecurringExpenseTemplate`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HOFundReceipt` ADD CONSTRAINT `HOFundReceipt_recordedById_fkey` FOREIGN KEY (`recordedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Vendor` ADD CONSTRAINT `Vendor_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RecurringExpenseTemplate` ADD CONSTRAINT `RecurringExpenseTemplate_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Student` ADD CONSTRAINT `Student_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Student` ADD CONSTRAINT `Student_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `Lead`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Student` ADD CONSTRAINT `Student_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AcademyModule` ADD CONSTRAINT `AcademyModule_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Batch` ADD CONSTRAINT `Batch_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BatchCourseSchedule` ADD CONSTRAINT `BatchCourseSchedule_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `Batch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BatchCourseSchedule` ADD CONSTRAINT `BatchCourseSchedule_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerAssignment` ADD CONSTRAINT `TrainerAssignment_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerAssignment` ADD CONSTRAINT `TrainerAssignment_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentBatchEnrollment` ADD CONSTRAINT `StudentBatchEnrollment_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentBatchEnrollment` ADD CONSTRAINT `StudentBatchEnrollment_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentAttendance` ADD CONSTRAINT `StudentAttendance_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentAttendance` ADD CONSTRAINT `StudentAttendance_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentAttendance` ADD CONSTRAINT `StudentAttendance_markedById_fkey` FOREIGN KEY (`markedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KRAEntry` ADD CONSTRAINT `KRAEntry_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KRAEntry` ADD CONSTRAINT `KRAEntry_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `AcademyModule`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `KRAEntry` ADD CONSTRAINT `KRAEntry_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleTest` ADD CONSTRAINT `ModuleTest_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleTest` ADD CONSTRAINT `ModuleTest_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `AcademyModule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleMark` ADD CONSTRAINT `ModuleMark_testId_fkey` FOREIGN KEY (`testId`) REFERENCES `ModuleTest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleMark` ADD CONSTRAINT `ModuleMark_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleFeedback` ADD CONSTRAINT `ModuleFeedback_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleFeedback` ADD CONSTRAINT `ModuleFeedback_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `AcademyModule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleFeedback` ADD CONSTRAINT `ModuleFeedback_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModuleFeedback` ADD CONSTRAINT `ModuleFeedback_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerFeedback` ADD CONSTRAINT `TrainerFeedback_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerFeedback` ADD CONSTRAINT `TrainerFeedback_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerFeedback` ADD CONSTRAINT `TrainerFeedback_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CourseFeedback` ADD CONSTRAINT `CourseFeedback_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CourseFeedback` ADD CONSTRAINT `CourseFeedback_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CourseFeedback` ADD CONSTRAINT `CourseFeedback_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Referral` ADD CONSTRAINT `Referral_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Certificate` ADD CONSTRAINT `Certificate_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Certificate` ADD CONSTRAINT `Certificate_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `AcademyCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementDrive` ADD CONSTRAINT `PlacementDrive_partnerId_fkey` FOREIGN KEY (`partnerId`) REFERENCES `HiringPartner`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementDrive` ADD CONSTRAINT `PlacementDrive_organizedById_fkey` FOREIGN KEY (`organizedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementResult` ADD CONSTRAINT `PlacementResult_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `PlacementDrive`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementResult` ADD CONSTRAINT `PlacementResult_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementInterview` ADD CONSTRAINT `PlacementInterview_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementInterview` ADD CONSTRAINT `PlacementInterview_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `PlacementDrive`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementInterview` ADD CONSTRAINT `PlacementInterview_feedbackGivenById_fkey` FOREIGN KEY (`feedbackGivenById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementDriveCandidate` ADD CONSTRAINT `PlacementDriveCandidate_driveId_fkey` FOREIGN KEY (`driveId`) REFERENCES `PlacementDrive`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementDriveCandidate` ADD CONSTRAINT `PlacementDriveCandidate_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PlacementDriveCandidate` ADD CONSTRAINT `PlacementDriveCandidate_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SoftskillSession` ADD CONSTRAINT `SoftskillSession_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SoftskillAttendance` ADD CONSTRAINT `SoftskillAttendance_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `SoftskillSession`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SoftskillAttendance` ADD CONSTRAINT `SoftskillAttendance_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Campaign` ADD CONSTRAINT `Campaign_ownerId_fkey` FOREIGN KEY (`ownerId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Campaign` ADD CONSTRAINT `Campaign_closedById_fkey` FOREIGN KEY (`closedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignRecharge` ADD CONSTRAINT `CampaignRecharge_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignRecharge` ADD CONSTRAINT `CampaignRecharge_rechargedById_fkey` FOREIGN KEY (`rechargedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignDailyReport` ADD CONSTRAINT `CampaignDailyReport_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `Campaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CampaignDailyReport` ADD CONSTRAINT `CampaignDailyReport_reportedById_fkey` FOREIGN KEY (`reportedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PasswordLog` ADD CONSTRAINT `PasswordLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnboardingRequest` ADD CONSTRAINT `OnboardingRequest_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnboardingDocument` ADD CONSTRAINT `OnboardingDocument_onboardingId_fkey` FOREIGN KEY (`onboardingId`) REFERENCES `OnboardingRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ResignationRequest` ADD CONSTRAINT `ResignationRequest_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExitClearance` ADD CONSTRAINT `ExitClearance_resignationId_fkey` FOREIGN KEY (`resignationId`) REFERENCES `ResignationRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExitDocument` ADD CONSTRAINT `ExitDocument_exitClearanceId_fkey` FOREIGN KEY (`exitClearanceId`) REFERENCES `ExitClearance`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `AcademyModule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectRelease` ADD CONSTRAINT `ProjectRelease_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectRelease` ADD CONSTRAINT `ProjectRelease_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectRelease` ADD CONSTRAINT `ProjectRelease_releasedById_fkey` FOREIGN KEY (`releasedById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectSubmission` ADD CONSTRAINT `ProjectSubmission_releaseId_fkey` FOREIGN KEY (`releaseId`) REFERENCES `ProjectRelease`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectSubmission` ADD CONSTRAINT `ProjectSubmission_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProjectSubmission` ADD CONSTRAINT `ProjectSubmission_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackForm` ADD CONSTRAINT `FeedbackForm_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `AcademyModule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackForm` ADD CONSTRAINT `FeedbackForm_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackFormQuestion` ADD CONSTRAINT `FeedbackFormQuestion_formId_fkey` FOREIGN KEY (`formId`) REFERENCES `FeedbackForm`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackFormRelease` ADD CONSTRAINT `FeedbackFormRelease_formId_fkey` FOREIGN KEY (`formId`) REFERENCES `FeedbackForm`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackFormRelease` ADD CONSTRAINT `FeedbackFormRelease_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackFormRelease` ADD CONSTRAINT `FeedbackFormRelease_releasedById_fkey` FOREIGN KEY (`releasedById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackFormResponse` ADD CONSTRAINT `FeedbackFormResponse_releaseId_fkey` FOREIGN KEY (`releaseId`) REFERENCES `FeedbackFormRelease`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackFormResponse` ADD CONSTRAINT `FeedbackFormResponse_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackAnswer` ADD CONSTRAINT `FeedbackAnswer_responseId_fkey` FOREIGN KEY (`responseId`) REFERENCES `FeedbackFormResponse`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FeedbackAnswer` ADD CONSTRAINT `FeedbackAnswer_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `FeedbackFormQuestion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTest` ADD CONSTRAINT `OnlineTest_moduleId_fkey` FOREIGN KEY (`moduleId`) REFERENCES `AcademyModule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTest` ADD CONSTRAINT `OnlineTest_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestQuestion` ADD CONSTRAINT `OnlineTestQuestion_testId_fkey` FOREIGN KEY (`testId`) REFERENCES `OnlineTest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestRelease` ADD CONSTRAINT `OnlineTestRelease_testId_fkey` FOREIGN KEY (`testId`) REFERENCES `OnlineTest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestRelease` ADD CONSTRAINT `OnlineTestRelease_scheduleId_fkey` FOREIGN KEY (`scheduleId`) REFERENCES `BatchCourseSchedule`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestRelease` ADD CONSTRAINT `OnlineTestRelease_activatedById_fkey` FOREIGN KEY (`activatedById`) REFERENCES `Employee`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestAttempt` ADD CONSTRAINT `OnlineTestAttempt_releaseId_fkey` FOREIGN KEY (`releaseId`) REFERENCES `OnlineTestRelease`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestAttempt` ADD CONSTRAINT `OnlineTestAttempt_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestAnswer` ADD CONSTRAINT `OnlineTestAnswer_attemptId_fkey` FOREIGN KEY (`attemptId`) REFERENCES `OnlineTestAttempt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OnlineTestAnswer` ADD CONSTRAINT `OnlineTestAnswer_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `OnlineTestQuestion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentPortfolio` ADD CONSTRAINT `StudentPortfolio_studentId_fkey` FOREIGN KEY (`studentId`) REFERENCES `Student`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StudentPortfolio` ADD CONSTRAINT `StudentPortfolio_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
