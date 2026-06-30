# AGENTS.md

GPU Cloud Dashboard — Next.js 16, Prisma/MariaDB, hosted.ai GPU backend, optional Stripe.

## Quick start

```bash
pnpm install                    # node >=22.13, pnpm >=9 (11.5.1 in lockfile)
cp .env.example .env.local      # only DATABASE_URL is required at boot
npx prisma db push              # create/migrate DB
pnpm dev                        # http://localhost:3000
pnpm build                      # clears .next/cache first, then next build
npx tsc --noEmit                # type-check without building
```

## Test commands

| command | what |
|---|---|
| `pnpm test` | Vitest watch mode |
| `pnpm test:unit` | Vitest single run |
| `pnpm test:backend` | backend project only (node env) |
| `pnpm test:frontend` | frontend project only (jsdom env) |
| `pnpm test:coverage` | measurement only (exits 0). `COVERAGE_GATE=1` enforces 70% |
| `pnpm test:e2e` | Playwright, sequential (1 worker) |
| `pnpm test:e2e:headed` | E2E with browser visible |
| `pnpm lint` | ESLint (flat config) |

**Vitest projects** — vitest.config.ts defines two projects (`backend` and `frontend`) that run independently in parallel. File location determines project:
- `tests/lib/`, `tests/api/`, `tests/regression/`, `tests/example.test.ts` → backend (node)
- `tests/components/`, `tests/hooks/`, `tests/pages/` → frontend (jsdom)

**Quarantine system** — test files in `QUARANTINE[]` at vitest.config.ts are excluded in CI only; they still run locally. Empty as of 2026-06.

**Setup** — `tests/setup.ts` mocks env vars (JWT secrets, DATABASE_URL, Stripe). Tests don't need a real DB. `@testing-library/jest-dom/vitest` imported globally.

**Playwright** — identity via `tests/e2e/.auth/user.json` (storageState). `TEST_AUTH_TOKEN` env var supported. No webServer config — you start the dev server yourself.

## Architecture (what matters for coding)

- **No server actions**. Middleware blocks POST to non-API routes (returns 405).
- **Two editions**: Pro and OSS. Set `NEXT_PUBLIC_EDITION=oss` for OSS. Premium tabs are dynamic-imported; their source files are physically removed from the OSS export.
- **Admin panel** is a SPA at `/admin?tab=X`. Adding a tab: add to `AdminTab` type → `VALID_ADMIN_TABS` → create component → export → sidebar → getTabLabel → render case → API route.
- **All amounts in cents** (integers). Stripe `balance` is negative for credits.
- **Settings resolution chain**: DB (`SystemSetting` table) → `process.env`. `getSetting(key)` from `src/lib/settings.ts`.
- **Branding resolution chain**: tenant config → env var → edition default. `NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_APP_URL`, etc.
- **File-based bootstrap**: `data/admins.json`, `data/secrets.json`, `data/invite-tokens.json` exist before DB init. JWT secrets are auto-generated on first run.
- **Prisma client is externalized** (`serverExternalPackages` in next.config.ts). After `prisma generate`, the app must be restarted.
- **Cron routes** accept both POST and GET (GET calls POST for manual testing).
- **Middleware** also sets `x-tenant-host` header from the request hostname on every request.

## Conventions

- `@/*` path alias → `./src/*`
- `"use client"` directive where needed — no server actions, no RSC streaming patterns used
- Native modules: ssh2, argon2, bcrypt, better-sqlite3, sharp (all need build toolchain). `pnpm-workspace.yaml` explicitly allows their build scripts.
- Formatting/config: Tailwind CSS 4 via `@tailwindcss/postcss`. ESLint 9 flat config (`eslint.config.mjs`). No Prettier.
- Stripe webhook events idempotent (via `ProcessedStripeEvent` table).
- Admin auth: file-based admins.json for user list + scrypt password hashing + JWT in `admin_session` cookie. TOTP 2FA optional.

## OSS Edition — Stripe-free mode

When `NEXT_PUBLIC_EDITION=oss` and `STRIPE_SECRET_KEY` is not set, the app uses synthetic `oss_*` customer IDs stored in `customer_cache` table instead of Stripe customers.

### Files modified for Stripe-free OSS:

| File | Change |
|---|---|
| `src/lib/stripe.ts` | Added `getStripeOrNull()` — returns null instead of throwing |
| `src/lib/auth/account-resolver.ts` | Resolves from `customer_cache` when no Stripe |
| `src/lib/auth/helpers.ts` | `getAuthenticatedCustomer()` falls back to `customer_cache` |
| `src/lib/auth/accept-invitation.ts` | Resolves team ID from `customer_cache` |
| `src/lib/customer-resolver.ts` | Returns null early when no Stripe |
| `src/lib/customer-login-email.ts` | Sends login email via local cache when no Stripe |
| `src/lib/wallet.ts` | `getWalletBalance()`/`deductUsage()` use `customer_cache.balance_cents` |
| `src/lib/voucher/index.ts` | Graceful error when no Stripe |
| `src/app/api/account/signup/route.ts` | Generates `oss_*` ID, creates hosted.ai team, stores team ID in cache |
| `src/app/api/account/verify/route.ts` | Reads balance + team from `customer_cache` |
| `src/app/api/account/route.ts` | Skips Stripe lookup, falls back to local cache |
| `src/app/api/account/profile/route.ts` | Skips Stripe update when no Stripe |
| `src/app/api/admin/customers/[id]/route.ts` | login-as, send-credentials, adjust-credits, set-balance, delete all use local cache |
| `src/app/api/admin/customers/[id]/details/route.ts` | Reads from `customer_cache` |
| `src/app/api/session/accounts/route.ts` | Returns own account from local cache |

### Wallet balance convention

- `customer_cache.balance_cents` uses **Stripe convention**: positive = debt, negative = credit
- Display flips sign: `walletBalance = -(balance_cents)` → positive = credit
- Admin `adjust-credits` stores negative for credit additions; `set-balance` stores `-targetCents`

### Signup flow (OSS)

1. Check `customer_cache` for duplicate email → redirect if exists
2. Generate `oss_<random>` customer ID
3. Create `customer_cache` entry with `billingType: "free"`
4. If hosted.ai configured: fetch default policies via `/policy/defaults` (user panel API), create team, store `team_id` in cache
5. Send welcome email via SMTP
6. Show "Check your email" on the account page (no auto-login)

### hosted.ai API quirks

- **Two APIs**: User panel (`HOSTEDAI_API_URL`, API key auth at `gpu.yeticloud.ai`) vs Admin panel (`HOSTEDAI_ADMIN_URL`, cookie auth at `admin.gpu.yeticloud.ai`)
- **`/policy/defaults`** lives on the user panel API (uses `X-API-Key` header), NOT the admin API
- **Don't use `?nature=general`** query param — some API versions don't support it and it filters out the resource policy
- **Parser must prefer general over baremetal** policies — the API returns both, and baremetal policies cause "invalid policy id" errors
- **`createTeam`** must always send the `general` block (Ariel HAI format) when `resource_policy_id` is provided; otherwise use flat (Titan) format
- **`resource` policy is optional** — not all hosted.ai instances have a default resource policy configured

## Before committing

```bash
pnpm lint
pnpm build                          # includes type-check
# or: npx tsc --noEmit
pnpm test:unit                      # or pnpm test:backend + pnpm test:frontend
```
