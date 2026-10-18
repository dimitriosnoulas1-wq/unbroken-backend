# Deploying the backend to Cloud Run

Neither repository records the Cloud Run service, project or region. The phone
learns the URL from *Ρυθμίσεις → AI planner*. Fill in the placeholders from the
read-only commands in step 0. Nothing here changes data: the backend stores
nothing, so a deploy only replaces the code that answers `/v1/plan` and
`/v1/screen/step`.

## 0. Identify what will be affected (read-only)

```bash
gcloud auth login                                   # an account with run.viewer on the project
gcloud projects list
gcloud run services list --platform managed --format="table(metadata.name,region,status.url)"
# Pick the row whose URL equals the one in the phone's settings:
export PROJECT=<project-id> REGION=<region> SERVICE=<service>
gcloud run services describe $SERVICE --project $PROJECT --region $REGION \
  --format="value(status.latestReadyRevisionName,status.traffic)"
export PREV_REVISION=<latestReadyRevisionName from above>   # the rollback target
gcloud run services describe $SERVICE --project $PROJECT --region $REGION \
  --format="yaml(spec.template.spec.containers[0].env)"       # names only: secrets show as secretKeyRef
```

Write down `PREV_REVISION` and its traffic split before anything else.

## 1. Pre-deployment checks

- CI is green on the commit being deployed (backend job: `npm ci`, typecheck, tests, `npm audit --omit=dev`).
- Locally: `npm ci && npm run typecheck && npm test`.
- `docker build -t unbroken-backend .` succeeds.
- The env var names on the live service match `.env.example` (`DEVICE_TOKENS_SHA256`, `PROVIDER`, `GEMINI_API_KEY` as a secret, `TRUST_PROXY=1`). This change adds no new variables.

## 2. Deploy with no traffic, test, then shift

```bash
gcloud run deploy $SERVICE --project $PROJECT --region $REGION \
  --source . --no-traffic --tag candidate
# Prints https://candidate---<service>-<hash>.<region>.run.app
CAND=https://candidate---...run.app
curl -s $CAND/healthz                                      # 200
curl -s -H "Authorization: Bearer $DEVICE_TOKEN" $CAND/v1/ping   # 200 (token from your password manager, never pasted in chat)
```

`--source` keeps the existing env vars and secrets. With `--no-traffic` the
phone keeps using `PREV_REVISION` while the candidate is tested. Optionally
point the phone at `$CAND` and run the Instagram checklist items from the main
README. Then:

```bash
gcloud run services update-traffic $SERVICE --project $PROJECT --region $REGION --to-tags candidate=100
```

## 3. After the switch

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE AND severity>=WARNING" \
  --project $PROJECT --freshness 15m --limit 50
```

Look for `invalid_plan`, `screen_step` errors and 5xx. Logs carry no transcripts.

## Rollback (seconds, no rebuild)

```bash
gcloud run services update-traffic $SERVICE --project $PROJECT --region $REGION --to-revisions $PREV_REVISION=100
```

The phone needs no change: the URL stays the same.
