-- Adds PT (Placement Training — joins directly for placement, no course at
-- all) as a fourth StudentTrack value, alongside JRP/IOP/PAP.

ALTER TABLE `Student`
  MODIFY `track` ENUM('JRP', 'IOP', 'PAP', 'PT') NOT NULL DEFAULT 'JRP';

ALTER TABLE `KRAEntry`
  MODIFY `track` ENUM('JRP', 'IOP', 'PAP', 'PT') NULL;
