-- Which student tracks may attend a combined (Soft Skills) class, comma-wrapped e.g. ",IOP,ELITE,".
ALTER TABLE `LiveClass` ADD COLUMN `tracks` VARCHAR(191) NULL;
