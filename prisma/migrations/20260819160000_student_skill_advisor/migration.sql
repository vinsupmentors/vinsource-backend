-- AlterTable
ALTER TABLE `Student` ADD COLUMN `skillAdvisorId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `Student` ADD CONSTRAINT `Student_skillAdvisorId_fkey` FOREIGN KEY (`skillAdvisorId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
