-- Message templates (WhatsApp / email) and target-vs-achievement alert setting
CREATE TABLE `MessageTemplate` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `channel` VARCHAR(191) NOT NULL,
  `category` VARCHAR(191) NULL,
  `subject` VARCHAR(191) NULL,
  `body` TEXT NOT NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `createdById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `MessageTemplate_channel_active_idx`(`channel`, `active`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SalesTargetAlertConfig` (
  `id` VARCHAR(191) NOT NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `checkDays` VARCHAR(191) NOT NULL DEFAULT '10,15,20,25',
  `behindPercent` INTEGER NOT NULL DEFAULT 80,
  `notifyOwner` BOOLEAN NOT NULL DEFAULT true,
  `notifyAdmins` BOOLEAN NOT NULL DEFAULT true,
  `adminEmails` TEXT NULL,
  `sendHour` INTEGER NOT NULL DEFAULT 10,
  `lastSentOn` VARCHAR(191) NULL,
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `SalesTargetAlertConfig` (`id`, `updatedAt`) VALUES (UUID(), CURRENT_TIMESTAMP(3));

-- Starter templates (admin edits these on the Lead Tools screen)
INSERT INTO `MessageTemplate` (`id`, `name`, `channel`, `category`, `subject`, `body`, `updatedAt`) VALUES
  (UUID(), 'Demo reminder', 'WHATSAPP', 'Demo', NULL,
   'Hi {{firstName}}, this is {{salesperson}} from Vinsup Skill Academy. A reminder about your {{course}} demo ({{demoMode}}) on {{demoDate}} at {{demoTime}}. Please reply to confirm you can join.', CURRENT_TIMESTAMP(3)),
  (UUID(), 'Fee details', 'WHATSAPP', 'Fees', NULL,
   'Hi {{firstName}}, thanks for your interest in {{course}}. I will share the fee structure and the available payment options. Please let me know a good time to talk. - {{salesperson}}, Vinsup Skill Academy', CURRENT_TIMESTAMP(3)),
  (UUID(), 'Course brochure', 'WHATSAPP', 'Brochure', NULL,
   'Hi {{firstName}}, here is the {{course}} course brochure with the syllabus, duration and placement support. Do call me if you have any questions. - {{salesperson}}, Vinsup Skill Academy', CURRENT_TIMESTAMP(3)),
  (UUID(), 'Demo reminder (email)', 'EMAIL', 'Demo', 'Your {{course}} demo on {{demoDate}}',
   'Hi {{firstName}},\n\nThis is a reminder about your {{course}} demo ({{demoMode}}) on {{demoDate}} at {{demoTime}}.\n\nPlease reply to this email to confirm.\n\nRegards,\n{{salesperson}}\nVinsup Skill Academy', CURRENT_TIMESTAMP(3)),
  (UUID(), 'Fee details (email)', 'EMAIL', 'Fees', 'Fee details for {{course}}',
   'Hi {{firstName}},\n\nThank you for your interest in {{course}}. I will share the fee structure and the payment options available.\n\nPlease reply with a good time to talk.\n\nRegards,\n{{salesperson}}\nVinsup Skill Academy', CURRENT_TIMESTAMP(3)),
  (UUID(), 'Course brochure (email)', 'EMAIL', 'Brochure', '{{course}} - course details',
   'Hi {{firstName}},\n\nThank you for your interest in {{course}}. I will share the syllabus, duration and placement support details.\n\nRegards,\n{{salesperson}}\nVinsup Skill Academy', CURRENT_TIMESTAMP(3));
