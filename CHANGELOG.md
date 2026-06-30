# Changelog

All notable changes to GPU Cloud Dashboard will be documented in this file.

## [Unreleased]

### Changed
- Stripe-only features now degrade gracefully in OSS instead of 500ing.
  Customer-facing billing flows (checkout, wallet top-up, billing portal,
  voucher redemption) return a friendly "currently under construction"
  response, and the **Stripe billing-portal button is hidden** (desktop and
  mobile) in the OSS edition.
- Admin Stripe-only endpoints behave cleanly without Stripe: `stripe-products`
  returns an empty list, `business-metrics` returns zeroed metrics, and
  customer admin actions that require Stripe return "under construction".
- GPU instance routes that only needed Stripe to look up a team ID
  (`category-check`, `from-snapshot`, pool-subscription `snapshot/prepare`)
  now resolve it via the operating-context resolver, so they work in OSS.

### Fixed
- `refundDeployment()` now credits the local `customer_cache` wallet in OSS
  (previously it silently no-opped without Stripe, so failed deploys and
  early terminations were never refunded). Pool-subscription early-termination
  credit/charge reconciliation routes through the OSS wallet accordingly.

### Added
- **OSS Stripe-free mode**: the platform now runs end-to-end with no Stripe
  configuration. When `NEXT_PUBLIC_EDITION=oss` and `STRIPE_SECRET_KEY` is
  unset, customer identity, wallet balance, and hosted.ai team IDs are sourced
  from the local `customer_cache` table using synthetic `oss_*` IDs.
- `getStripeOrNull()` / `hasHostedAiConfig()` non-throwing helpers; all
  customer-facing `getStripe()` call sites fall back to `customer_cache`.
- OSS signup generates `oss_*` IDs, guards duplicate emails, sets
  `billingType: "free"`, and shows "check your email" instead of auto-login.

### Fixed
- **GPU deployment in OSS** no longer 500s. `POST /api/instances` used
  `getStripe()` unconditionally and stored its deploy-lock in Stripe customer
  metadata, both of which threw without Stripe. The deploy now uses
  `getStripeOrNull()` and a shared deploy-lock (`@/lib/deploy-lock`) backed by
  `customer_cache.metadataJson` in OSS and Stripe metadata in Pro. Monthly
  products return a clear "not available in this edition" error in OSS.
- The synthetic OSS customer hydrates its `metadata` from
  `customer_cache.metadataJson`, so metadata keys round-trip like a real
  Stripe customer.
- Account switching (`/api/session/switch-account`) no longer throws an
  unhandled 500 in OSS; the implicit-owner fallback resolves account identity
  from `customer_cache` when Stripe is absent.
- App deployability and pool-targeted dashboard announcements resolve the
  team ID from `customer_cache` in OSS instead of erroring and silently
  falling back.
- Stripe-dependent cron jobs no longer throw in OSS. Revenue/billing crons
  (`admin-stats`, `check-budgets`, `check-hf-deployments`, `wallet-refill`,
  `midnight-status-email`, `process-drip`, `fullSyncCustomerCache`) skip
  cleanly with a `skipped: true` response. `complete-provisioning` resolves
  active teams from `customer_cache`, and storage-alert emails resolve the
  recipient from `customer_cache` — both keep working without Stripe.
- hosted.ai policy resolution: dropped `?nature=general` (was filtering out the
  resource policy), prefer general over baremetal policies, and made
  `resource_policy_id` optional in `createTeam`.

## [0.1.2] - 2026-03-20

### Added
- Password-based admin login (no email provider needed for first setup)
- TOTP two-factor authentication for admin accounts
- Admin invite system with one-time setup tokens
- Login audit log with security health score
- Platform Settings UI for configuring all integrations from the admin panel
- DB-backed settings with AES-256-GCM encryption for sensitive keys
- SMTP email support (replaces vendor-specific email providers)
- Admin-customizable email templates
- Capability-based feature gating with informational banners
- `reconfigure.sh` for post-install configuration changes (domain, SSL, ports)
- `upgrade.sh` for zero-downtime upgrades
- `uninstall.sh` for clean removal
- VERSION file for deterministic version tracking

### Changed
- Install script defaults to `main` branch
- All scripts point to `github.com/hosted-ai/packet-oss`

### Removed
- Docker support (not yet implemented — will return in a future release)
