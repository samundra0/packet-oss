-- PA-201 reconciliation: rename the `admin` role slug to `teamAdmin`.
--
-- Why:
--   PA-201 says the single elevated role is "Team Admin" (no separate Owner
--   role surfaced). We aligned ROLE_PERMISSIONS to use the slug `teamAdmin`.
--   Existing rows from PR 1's backfill used `role='admin'`; flip them so
--   live DB state matches the TS enum.
--
-- Idempotency: safe to re-run. A second run is a no-op because no rows match.
--
-- Reversibility: trivial inverse (UPDATE team_membership SET role = 'admin'
-- WHERE role = 'teamAdmin') — kept in mind for rollback. Not destructive.

UPDATE `team_membership` SET `role` = 'teamAdmin' WHERE `role` = 'admin';
UPDATE `team_invitation` SET `role` = 'teamAdmin' WHERE `role` = 'admin';
