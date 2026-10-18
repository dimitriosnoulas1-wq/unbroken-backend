# Deploying the backend to Cloud Run

Neither repository records the Cloud Run service, project or region. The phone
learns the URL from *Ρυθμίσεις → AI planner*. Fill in the placeholders from the
read-only commands in step 0. Nothing here changes data: the backend stores
nothing, so a deploy only replaces the code that answers `/v1/plan` and
`/v1/screen/step`.

## Cloud Shell: deploy exactly the reviewed commit

Known service: `unbroken-backend`, region `europe-west1`. The usual
`git clone …unbroken-backend` takes **main**, not a pull-request branch. To deploy a
reviewed branch, pin it and check the commit before building:

```bash
cd ~ && rm -rf unbroken-backend-review
git clone --branch claude/unbroken-android-completion-agnlee --single-branch \
  https://github.com/dimitriosnoulas1-wq/unbroken-backend unbroken-backend-review
cd unbroken-backend-review
git rev-parse HEAD            # must equal the SHA named in the pull request / chat
grep -c 'invalid_step_${' src/app.ts   # 2 = this build names the reason on the phone
gcloud run services describe unbroken-backend --region europe-west1 \
  --format="value(status.latestReadyRevisionName)"   # note it: the rollback target
gcloud run deploy unbroken-backend --source . --region europe-west1 \
  --no-traffic --tag candidate --quiet
```

`--source` keeps the env vars and secrets (device token hashes, model, API key);
never pass `--set-env-vars` or `--env-vars-file`, which replace them. After the
candidate checks in step 2: `update-traffic … --to-tags candidate=100`. Rollback:
`update-traffic … --to-revisions <noted revision>=100`.

Revisions built with `--source` record no git commit. To tell which code a
revision runs, compare its creation time with the commit times
(`gcloud run revisions describe <rev> --region europe-west1 --format="value(metadata.creationTimestamp)"`),
or check the phone's error: a bare `invalid_step` means a build older than
`ec5a680`; `invalid_step_<reason>` means `ec5a680` or newer.

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
