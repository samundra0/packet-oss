-- PA-175 PR 2.5: schema additions for per-user SSH key removal + API key
-- effective-permissions precompute.
--
-- All columns are nullable. Existing rows get NULL and stay functional —
-- backfill is a separate script (scripts/migrations/2026-05-team-rbac/pr25-backfill.ts).
--
-- Reversibility:
--   ALTER TABLE ssh_key  DROP COLUMN user_id;
--   ALTER TABLE api_key  DROP COLUMN holder_user_id;
--   ALTER TABLE api_key  DROP COLUMN effective_permissions;
--   DROP INDEX idx_ssh_key_user_id ON ssh_key;
--   DROP INDEX idx_api_key_holder_user_id ON api_key;
-- (kept in mind for rollback; not destructive forward.)

ALTER TABLE `ssh_key` ADD COLUMN `user_id` VARCHAR(191) NULL;
CREATE INDEX `ssh_key_user_id_idx` ON `ssh_key`(`user_id`);

ALTER TABLE `api_key` ADD COLUMN `holder_user_id` VARCHAR(191) NULL;
ALTER TABLE `api_key` ADD COLUMN `effective_permissions` TEXT NULL;
CREATE INDEX `api_key_holder_user_id_idx` ON `api_key`(`holder_user_id`);
