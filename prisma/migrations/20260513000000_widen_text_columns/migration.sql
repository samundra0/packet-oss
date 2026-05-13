-- Widen VARCHAR columns to TEXT/LONGTEXT for fields that hold long admin-authored content.
--
-- The first three changes (dashboard_announcement.message, email_broadcast.html_body,
-- email_broadcast.text_body) were already hot-patched in prod after admins hit 500 errors
-- when sending longer announcements/broadcasts. The remaining three notes columns are
-- pre-emptive — same failure class, same fix, zero storage cost until used.
--
-- Idempotency: ALTER TABLE ... MODIFY COLUMN to a column's current type is a metadata-only
-- operation on modern MySQL/MariaDB, so this file is safe to re-run on databases where
-- some or all of these changes have already been applied. VARCHAR → TEXT/LONGTEXT also
-- cannot lose data (target type is strictly larger).

ALTER TABLE `dashboard_announcement`
  MODIFY COLUMN `message` TEXT NOT NULL;

ALTER TABLE `email_broadcast`
  MODIFY COLUMN `html_body` LONGTEXT NOT NULL,
  MODIFY COLUMN `text_body` LONGTEXT NULL;

ALTER TABLE `pod_metadata`
  MODIFY COLUMN `notes` TEXT NULL;

ALTER TABLE `pool_settings_override`
  MODIFY COLUMN `notes` TEXT NULL;

ALTER TABLE `provider_commercial_terms`
  MODIFY COLUMN `notes` TEXT NULL;
