-- Add suspension fields to customer_settings for fraud lockout
ALTER TABLE `customer_settings`
  ADD COLUMN `suspended` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `suspended_at` DATETIME(3) NULL,
  ADD COLUMN `suspended_reason` TEXT NULL,
  ADD COLUMN `suspended_by` VARCHAR(191) NULL;

CREATE INDEX `customer_settings_suspended_idx` ON `customer_settings` (`suspended`);
