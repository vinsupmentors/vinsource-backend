-- Add MON_FRI to the DayPattern enum (BatchCourseSchedule.dayPattern).
ALTER TABLE `BatchCourseSchedule` MODIFY COLUMN `dayPattern` ENUM('MON_SAT', 'MON_FRI', 'SAT_SUN', 'SUNDAY_ONLY', 'CUSTOM') NOT NULL;
