-- "Other work" no longer has a category.
ALTER TABLE `TrainerOtherWork` MODIFY `category` VARCHAR(191) NULL;
