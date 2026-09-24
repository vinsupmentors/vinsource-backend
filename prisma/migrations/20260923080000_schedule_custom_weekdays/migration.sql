-- Calendar module's "create event" flow adds a Google-Calendar-style
-- weekday picker (tick any combination of days, e.g. Mon/Wed/Fri only)
-- that the three existing coarse DayPattern values (MON_SAT/SAT_SUN/
-- SUNDAY_ONLY) can't express. CUSTOM is a new flag value; the actual
-- weekday selection lives in the new customWeekdays bitmask column
-- (bit 0 = Sunday ... bit 6 = Saturday). Every existing row keeps its
-- current dayPattern value unchanged and customWeekdays stays NULL.

-- AlterTable
ALTER TABLE `BatchCourseSchedule`
  MODIFY COLUMN `dayPattern` ENUM('MON_SAT', 'SAT_SUN', 'SUNDAY_ONLY', 'CUSTOM') NOT NULL,
  ADD COLUMN `customWeekdays` INTEGER NULL;
