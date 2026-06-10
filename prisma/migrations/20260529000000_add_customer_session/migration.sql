-- PA-267: persistent customer sessions (rolling 15-day, 30-day absolute cap).
--
-- Backs the httpOnly refresh cookie. The cookie carries a refresh JWT whose jti
-- is sha256-hashed into `token_hash`; this row is the revocable source of truth.
-- Logout sets `revoked_at`; "log out everywhere" revokes all rows for the user.
--
-- INERT until the session endpoints ship — no existing code reads this table,
-- so it is safe to land alone.
--
-- Rollback: DROP TABLE `customer_session`;

CREATE TABLE `customer_session` (
    `id` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(64) NOT NULL,
    `stripe_customer_id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NULL,
    `email` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,
    `absolute_expires_at` DATETIME(3) NOT NULL,
    `revoked_at` DATETIME(3) NULL,
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `user_agent` TEXT NULL,
    `ip` VARCHAR(64) NULL,

    UNIQUE INDEX `customer_session_token_hash_key`(`token_hash`),
    INDEX `customer_session_stripe_customer_id_idx`(`stripe_customer_id`),
    INDEX `customer_session_user_id_idx`(`user_id`),
    INDEX `customer_session_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
