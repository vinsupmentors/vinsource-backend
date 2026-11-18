-- Module curriculum version: V1 = original syllabus (batches before 19), V2 = Vinsup 2.0 (Batch 19+).
ALTER TABLE `AcademyModule` ADD COLUMN `curriculum` VARCHAR(191) NOT NULL DEFAULT 'V1';

-- New unique key first (it also serves the courseId foreign key), then drop the old one.
CREATE UNIQUE INDEX `AcademyModule_courseId_curriculum_order_key` ON `AcademyModule`(`courseId`, `curriculum`, `order`);
DROP INDEX `AcademyModule_courseId_order_key` ON `AcademyModule`;
