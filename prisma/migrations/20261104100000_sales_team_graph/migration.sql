ALTER TABLE `SalesTeamMap` DROP PRIMARY KEY, ADD PRIMARY KEY (`employeeId`, `tlId`);

CREATE TABLE `SalesTeamNode` (
  `employeeId` VARCHAR(191) NOT NULL,
  `x` INTEGER NOT NULL,
  `y` INTEGER NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`employeeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
