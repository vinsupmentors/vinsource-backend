-- The "Aspiring <role>" the student is targeting — shown on the public
-- portfolio page and used to suggest relevant skills in the edit form.

ALTER TABLE `StudentPortfolio`
  ADD COLUMN `targetRole` VARCHAR(191) NULL;
