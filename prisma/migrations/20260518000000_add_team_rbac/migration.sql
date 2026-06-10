-- PA-175: Team RBAC schema migration (PR 1 of 3).
--
-- This migration is INERT — no code reads the new tables yet. Permission gates,
-- new API routes, and UI changes ship in PR 2 and PR 3. PR 1 is safe to land alone.
--
-- Changes:
--   1. RENAME existing `team_member` to `team_member_legacy` (rollback safety net;
--      will be dropped in the release after PR 1 ships clean).
--   2. CREATE TABLE `user` — one row per real human, keyed by email.
--   3. CREATE TABLE `team_membership` — one row per (user, account) pair.
--      Columns: role (packet enum), is_owner (packet-owned, NOT synced from HAI),
--      revoked_at (immediate session invalidation), status (active/revoked).
--   4. CREATE TABLE `team_invitation` — pending invites with 7-day expiry tokens.
--   5. CREATE TABLE `team_audit_log` — append-only trail for permission events.
--
-- See docs/designs/team-rbac.md for the full architecture rationale.
--
-- Rollback (during PR 1 review/staging window):
--   - The legacy table is RENAMED, not dropped. To roll back:
--     ALTER TABLE `team_member_legacy` RENAME TO `team_member`;
--     DROP TABLE `team_audit_log`;
--     DROP TABLE `team_invitation`;
--     DROP TABLE `team_membership`;
--     DROP TABLE `user`;
--   - New tables are inert (no foreign keys point at them from existing code),
--     so dropping them is safe.

-- 1. Rename legacy table
ALTER TABLE `team_member` RENAME TO `team_member_legacy`;

-- 2. CreateTable: user
CREATE TABLE `user` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `user_email_key`(`email`),
    INDEX `user_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3. CreateTable: team_membership
--    `role` is a Packet-side enum string. Values: 'admin' | 'member' |
--    'readOnlyMember' | 'financeManager'. Enforced by application code, not DB.
--    `is_owner` is Packet-owned (HAI does not track team-creator). Exactly one
--    is_owner=TRUE per stripe_customer_id (application invariant).
CREATE TABLE `team_membership` (
    `id` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `stripe_customer_id` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `is_owner` BOOLEAN NOT NULL DEFAULT false,
    `invited_by_user_id` VARCHAR(191) NULL,
    `invited_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `accepted_at` DATETIME(3) NULL,
    `revoked_at` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `team_membership_user_id_stripe_customer_id_key`(`user_id`, `stripe_customer_id`),
    INDEX `team_membership_stripe_customer_id_status_idx`(`stripe_customer_id`, `status`),
    INDEX `team_membership_stripe_customer_id_is_owner_idx`(`stripe_customer_id`, `is_owner`),
    INDEX `team_membership_stripe_customer_id_revoked_at_idx`(`stripe_customer_id`, `revoked_at`),
    PRIMARY KEY (`id`),
    CONSTRAINT `team_membership_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4. CreateTable: team_invitation
--    Tokens are 32-byte hex (64 chars). Hashing at rest is a v1.5 follow-up
--    (filed in TODOS.md).
CREATE TABLE `team_invitation` (
    `id` VARCHAR(191) NOT NULL,
    `stripe_customer_id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `invited_by_user_id` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `accepted_at` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `team_invitation_token_key`(`token`),
    UNIQUE INDEX `team_invitation_stripe_customer_id_email_key`(`stripe_customer_id`, `email`),
    INDEX `team_invitation_stripe_customer_id_status_idx`(`stripe_customer_id`, `status`),
    INDEX `team_invitation_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5. CreateTable: team_audit_log
--    Append-only trail. 90-day cleanup cron added in PR 2. `payload` is opaque
--    JSON; consumers should not rely on a strict schema beyond `action`.
CREATE TABLE `team_audit_log` (
    `id` VARCHAR(191) NOT NULL,
    `stripe_customer_id` VARCHAR(191) NOT NULL,
    `actor_user_id` VARCHAR(191) NULL,
    `subject_user_id` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `payload` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `team_audit_log_stripe_customer_id_created_at_idx`(`stripe_customer_id`, `created_at`),
    INDEX `team_audit_log_actor_user_id_created_at_idx`(`actor_user_id`, `created_at`),
    INDEX `team_audit_log_subject_user_id_created_at_idx`(`subject_user_id`, `created_at`),
    INDEX `team_audit_log_action_idx`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
