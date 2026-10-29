CREATE TABLE `SalesTeamMap` (
  `employeeId` VARCHAR(191) NOT NULL,
  `tlId` VARCHAR(191) NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `SalesTeamMap_tlId_idx`(`tlId`),
  PRIMARY KEY (`employeeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
