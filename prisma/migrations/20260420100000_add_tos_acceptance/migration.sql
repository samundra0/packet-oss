-- Add TOS acceptance tracking table for versioned consent with audit trail
CREATE TABLE IF NOT EXISTS `tos_acceptance` (
    `id` VARCHAR(191) NOT NULL,
    `stripe_customer_id` VARCHAR(191) NOT NULL,
    `tos_version` VARCHAR(191) NOT NULL,
    `accepted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ip_address` VARCHAR(191) NULL,
    `user_agent` TEXT NULL,

    UNIQUE INDEX `tos_acceptance_stripe_customer_id_tos_version_key`(`stripe_customer_id`, `tos_version`),
    INDEX `tos_acceptance_stripe_customer_id_idx`(`stripe_customer_id`),
    INDEX `tos_acceptance_tos_version_idx`(`tos_version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed the TOS version (matches /terms page "Last updated: April 22, 2026")
INSERT INTO `system_setting` (`key`, `value`, `encrypted`, `updated_at`)
VALUES ('TOS_VERSION', '2026-04-22', 0, NOW())
ON DUPLICATE KEY UPDATE `value` = '2026-04-22', `updated_at` = NOW();
