-- Real SMTP/nodemailer failure messages (auth errors, quota/rate-limit
-- responses, etc.) routinely exceed the old VARCHAR(191) cap. When that
-- happened, the FAILED-row insert in emailService.send()'s catch block
-- itself threw ("Data too long for column"), silently swallowing the real
-- error and leaving no EmailLog row at all for that failed send. TEXT
-- removes that trap.
ALTER TABLE `EmailLog` MODIFY COLUMN `errorMsg` TEXT NULL;
