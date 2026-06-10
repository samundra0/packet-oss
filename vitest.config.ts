import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// ── Quarantine ──────────────────────────────────────────────────────────────
// Test files that are red on `main` as of the CI-introduction baseline
// (2026-06-02). They are excluded from CI runs ONLY (process.env.CI), so the
// new pipeline can gate green on the passing suite while these are triaged.
// They STILL RUN locally so the failures stay visible to anyone working here.
// Tracked in PA-273. De-quarantine a file by deleting its line once its
// failing cases are fixed (highest ROI first — e.g. gpu-specs: fix 5, restore 57).
// Quarantine list is empty — all previously-red tests have been fixed
// (gpu-specs via #42, the rest via this PR). The machinery below is a no-op
// now; safe to delete in a follow-up.
const QUARANTINE: string[] = [];

const quarantined = process.env.CI ? QUARANTINE : [];
const sharedExclude = ['tests/e2e/**/*', 'node_modules/**/*'];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    setupFiles: './tests/setup.ts',
    // Coverage is a global (root) concern; both projects report into it.
    coverage: {
      provider: 'v8',
      // text-summary prints the headline totals (the per-file `text` table is
      // unreadable at ~800 included files); json-summary writes
      // coverage/coverage-summary.json so the % is trackable PR-over-PR.
      reporter: ['text-summary', 'json-summary', 'html'],
      // Vitest 4 removed `coverage.all` — `include` is now how untested files
      // get counted. Restricting to ts/tsx also keeps the v8 remapper away
      // from non-code files under src/ (e.g. src/plans/*.md, lib READMEs),
      // which crash it. Without this block the report only counts files the
      // tests happened to load, which wildly inflates the headline number.
      include: ['src/**/*.{ts,tsx}'],
      // The repo's 70% gate is intentionally dormant until coverage gets
      // there (campaign Phase 6). Opt in with COVERAGE_GATE=1; a bare
      // `pnpm test:coverage` is a measurement, not a gate, and must exit 0.
      ...(process.env.COVERAGE_GATE
        ? {
            thresholds: {
              lines: 70,
              functions: 70,
              branches: 70,
              statements: 70,
            },
          }
        : {}),
      exclude: [
        'node_modules/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
        '.next/**',
      ],
    },
    // Two projects so front-end and back-end suites run (and fail) independently
    // and can fan out as separate parallel CI steps. Back-end runs under `node`;
    // front-end runs under `jsdom` so component tests can render. Per-file
    // `// @vitest-environment` docblocks still override on a per-file basis.
    projects: [
      {
        extends: true,
        test: {
          name: 'backend',
          environment: 'node',
          include: [
            'tests/lib/**/*.test.{ts,tsx}',
            'tests/api/**/*.test.{ts,tsx}',
            'tests/regression/**/*.test.{ts,tsx}',
            'tests/example.test.ts',
          ],
          exclude: [...sharedExclude, ...quarantined],
        },
      },
      {
        extends: true,
        test: {
          name: 'frontend',
          environment: 'jsdom',
          include: [
            'tests/components/**/*.test.{ts,tsx}',
            'tests/hooks/**/*.test.{ts,tsx}',
            'tests/pages/**/*.test.{ts,tsx}',
          ],
          exclude: [...sharedExclude, ...quarantined],
        },
      },
    ],
  },
});
