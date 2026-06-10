-- PA-158: Track whether HAI actually started the pod after createInstance.
--
-- The dashboard and API routes pre-charge the wallet, then call HAI createInstance.
-- HAI can return an instance ID while the pod silently fails to start (stuck in an
-- error/stopped state and deleted ~10min later). Without tracking, the customer
-- loses the pre-charge with no refund.
--
-- deploy_status values:
--   "provisioning"      → createInstance returned an id, waiting for "running"
--   "running"           → HAI confirmed the pod is up; pre-charge stands
--   "failed_refunded"   → pod never started; wallet refunded, HAI delete attempted
--
-- deploy_status_reason carries the human-readable failure cause when
-- deploy_status = "failed_refunded" (e.g. "terminal status: error",
-- "instance deleted by HAI", "poll timeout after 13min").
--
-- Idempotency: NULL is the legacy/migrated value, so existing rows match the
-- "treat as running for billing" path. Safe to deploy without backfill.

ALTER TABLE `pod_metadata`
  ADD COLUMN `deploy_status` VARCHAR(32) NULL,
  ADD COLUMN `deploy_status_reason` TEXT NULL;

CREATE INDEX `pod_metadata_deploy_status_idx` ON `pod_metadata` (`deploy_status`);
