# Smoke Tests

## Quick API Smoke

Runs a fast sanity check for critical endpoints and contracts:

1. CSRF token issue
2. Admin login
3. `/auth/me` ID shape (`_id` + `id`)
4. Refresh token endpoint
5. Signed upload URL contract
6. Upload view redirect endpoint
7. Reports pipeline response shape
8. Admin users endpoint

Command:

```bash
npm run smoke:api
```

Optional environment variables:

- `SMOKE_BASE_URL` (default: `http://localhost:5000/api/v1`)
- `SMOKE_ADMIN_EMAIL` (default: `admin@rmvsteelfab.com`)
- `SMOKE_ADMIN_PASSWORD` (default: `Admin@12345`)

Example:

```bash
SMOKE_BASE_URL=http://localhost:5000/api/v1 npm run smoke:api
```

## Full Pipeline Smoke

Runs the long end-to-end workflow script:

```bash
npm run smoke:pipeline
```

This validates the full role handoff flow and is slower than `smoke:api`.

## Phase 3 Safeguards Smoke

Runs focused checks for the new safeguards introduced in Phase 3:

1. Config impact preview endpoint
2. Config version history and rollback flow
3. Payment evidence trail endpoint
4. Refund dispatch and reconciliation endpoints (optional mutation mode)

Command:

```bash
npm run smoke:phase3
```

Optional environment variables:

- `SMOKE_BASE_URL` (default: `http://localhost:5000/api/v1`)
- `SMOKE_ADMIN_EMAIL`
- `SMOKE_ADMIN_PASSWORD`
- `SMOKE_PHASE3_KEY` (default: `smoke_phase3_probe`)
- `SMOKE_PHASE3_STRICT=true` to fail when optional checks are skipped
- `SMOKE_ALLOW_MUTATIONS=true` to execute refund dispatch/reconcile
- `SMOKE_REFUND_ID` to target a specific approved refund
- `SMOKE_PAYMENT_ID` to target a specific payment evidence-trail record

Notes:

- When `SMOKE_ALLOW_MUTATIONS=true`, the script may promote one pending refund to approved for dispatch testing.
- In strict + mutation mode, if no approved refund exists, a minimal smoke fixture refund can be created automatically (Mongo-backed fallback) to validate dispatch/reconcile endpoints.

Examples:

```bash
# Read-heavy mode (safe default)
npm run smoke:phase3

# Strict validation (fails if refund/payment-positive checks are skipped)
SMOKE_PHASE3_STRICT=true npm run smoke:phase3

# Full mutation pass for staging
SMOKE_ALLOW_MUTATIONS=true SMOKE_PHASE3_STRICT=true npm run smoke:phase3
```
