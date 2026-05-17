# Wave 1 — install + follow-up notes for the merge agent

This file is written by **Agent D (deploy/CI)** and should be deleted after merge once the items below are resolved.

## New dependencies

Agent D introduced **no new runtime dependencies**. The healthcheck route at `app/api/health/route.ts` consumes `ioredis` (which Agent B is installing in parallel) through a runtime string-resolved dynamic import — so it typechecks and runs cleanly whether or not `ioredis` is present in `node_modules`.

Nothing to install. Once Agent B's branch lands and `ioredis` is in `package.json`, the healthcheck will pick it up automatically and start pinging Redis when `REDIS_URL` is set.

## Known pre-existing issue: `npm run build` fails on dashboard prerender

The CI workflow (`.github/workflows/ci.yml`) runs `npm run build` against a throwaway Postgres service container. The build currently fails at **prerender** time on two pages:

- `/dashboard/polls` — calls Prisma at module scope during static export
- `/dashboard/search` — `useSearchParams()` without a `<Suspense>` boundary

Both pages live under `app/(app)/dashboard/`, which Agent D was explicitly instructed **not to touch**. Both failures **predate** any of Agent D's changes — confirmed by running `npm run build` on the parent branch.

**Fix at merge time (any of):**

1. Add `export const dynamic = "force-dynamic"` to the affected dashboard pages, OR
2. Wrap the `useSearchParams()` call site in a `<Suspense>` boundary, OR
3. Add `dynamic = "force-dynamic"` to `app/(app)/layout.tsx` so the whole app shell opts out of prerender.

Option 3 is the lowest-touch fix.

## Files added / modified by Agent D

- `vercel.json` — function `maxDuration` overrides (SSE + LLM streaming routes)
- `.env.production.example` — production env template
- `.github/workflows/ci.yml` — CI for typecheck / lint / build
- `app/api/health/route.ts` — `/api/health` with DB + Redis pings
- `.vercelignore` — exclude local-only artifacts from the Vercel build context
- `README.md` — new **Deployment** section
- `WAVE1_INSTALL.md` — this file
