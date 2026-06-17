# Back Channel — Deploy to Google Cloud Run

Step-by-step. Run these from a machine with `gcloud` installed and authed.

**Prerequisites:**
- A Google Cloud project with billing enabled
- Domain `backchannel.app` (or whatever you choose) ready to map DNS
- ~$15-25/month budget for Cloud Run + Cloud SQL

---

## 0. One-time setup

```bash
# Pick a project ID. If creating new:
PROJECT_ID="back-channel-prod"   # change as you like
gcloud projects create "$PROJECT_ID" --name="Back Channel"

# OR use existing:
PROJECT_ID="<your existing project>"

gcloud config set project "$PROJECT_ID"
gcloud auth login
gcloud auth application-default login

# Enable APIs we need
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  containerregistry.googleapis.com
```

---

## 1. Provision Cloud SQL (Postgres)

```bash
gcloud sql instances create backchannel-db \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=us-west1 \
  --root-password="<set a strong password>" \
  --storage-size=10GB \
  --storage-auto-increase

gcloud sql databases create backchannel --instance=backchannel-db

# Create app user
gcloud sql users create backchannel-app \
  --instance=backchannel-db \
  --password="<strong app password>"

# Get the connection name (PROJECT:REGION:INSTANCE)
CLOUDSQL_INSTANCE=$(gcloud sql instances describe backchannel-db --format="value(connectionName)")
echo "$CLOUDSQL_INSTANCE"
```

**Cost note:** `db-f1-micro` is ~$10/month. Upgrade to `db-g1-small` ($25/month) when traffic justifies.

---

## 2. Store DATABASE_URL as a secret

```bash
# Format: postgresql://USER:PASS@/DBNAME?host=/cloudsql/CONNECTION_NAME
DATABASE_URL="postgresql://backchannel-app:<strong app password>@/backchannel?host=/cloudsql/$CLOUDSQL_INSTANCE"

echo -n "$DATABASE_URL" | gcloud secrets create DATABASE_URL --data-file=-

# Grant Cloud Run service access
gcloud secrets add-iam-policy-binding DATABASE_URL \
  --member="serviceAccount:$PROJECT_ID@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```


## 3. Run database migrations

Either from your laptop with the Cloud SQL proxy:

```bash
# Install the Cloud SQL proxy (one-time)
# https://cloud.google.com/sql/docs/postgres/sql-proxy

# Start proxy
cloud-sql-proxy "$CLOUDSQL_INSTANCE" --port=5432 &

# In apps/broker/, run prisma migration
cd apps/broker
DATABASE_URL="postgresql://backchannel-app:<password>@localhost:5432/backchannel" \
  npx prisma migrate deploy

# Stop the proxy
kill %1
```

Or from a Cloud Build step (preferred for CI/CD — add a migration step to cloudbuild.yaml later).

---

## 4. First deploy

From the repo root:

```bash
# Build and push the image, then deploy
gcloud builds submit \
  --config=apps/broker/cloudbuild.yaml \
  --substitutions=_CLOUDSQL_INSTANCE="$CLOUDSQL_INSTANCE"
```

This:
1. Builds the Docker image (multi-stage, lands at gcr.io/$PROJECT_ID/backchannel-broker:$SHORT_SHA)
2. Pushes it
3. Deploys to Cloud Run service `backchannel-broker` in `us-west1`
4. Pins min/max instances to 1 (Phase 3 MVP — see docs/production-architecture.md)
5. Wires up Cloud SQL, env vars, secrets

Time: ~5-7 minutes first time.

After it finishes:

```bash
# Get the service URL
SERVICE_URL=$(gcloud run services describe backchannel-broker --region=us-west1 --format="value(status.url)")
echo "$SERVICE_URL"

# Smoke test
curl "$SERVICE_URL/"
curl "$SERVICE_URL/skill"
curl -X POST "$SERVICE_URL/api/accounts" -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'
```

You should see the landing page, the skill content, and a JSON response with an API key.

---

## 5. Map custom domain (optional but recommended)

```bash
# Verify domain ownership in Search Console first (one-time)
# https://search.google.com/search-console/welcome

gcloud beta run domain-mappings create \
  --service=backchannel-broker \
  --domain=backchannel.app \
  --region=us-west1

# Get the DNS records to add
gcloud beta run domain-mappings describe \
  --domain=backchannel.app \
  --region=us-west1
```

Add the returned `A` and `AAAA` records at your DNS provider. TLS cert provisions automatically (~15-30 min).

---

## 6. Set up Cloud Build trigger (continuous deploy)

Make pushes to `main` auto-deploy:

```bash
# Connect your GitHub repo to Cloud Build (one-time, via console)
# https://console.cloud.google.com/cloud-build/triggers/connect

gcloud beta builds triggers create github \
  --repo-name=back-channel \
  --repo-owner=skyflyt \
  --branch-pattern="^main$" \
  --build-config=apps/broker/cloudbuild.yaml \
  --substitutions=_CLOUDSQL_INSTANCE="$CLOUDSQL_INSTANCE"
```

From now on, every `git push origin main` deploys a fresh image.

---

## 7. Verify

```bash
# Tail logs
gcloud run services logs tail backchannel-broker --region=us-west1

# Check current status
gcloud run services describe backchannel-broker --region=us-west1
```

Open `https://backchannel.app` in a browser. You should see the landing page.

---

## Troubleshooting

**Build fails with `prisma generate` error:**
Check that `apps/broker/prisma/schema.prisma` is being copied into the build stage. The Dockerfile already handles this.

**Cloud Run service starts but 502 on requests:**
Check logs — likely a DATABASE_URL issue or a missing migration. Run `npx prisma migrate deploy` against your Cloud SQL instance.

**WebSocket connections drop after ~60 seconds:**
Cloud Run default request timeout is 60s; we override to 3600s in cloudbuild.yaml. If yours didn't apply, redeploy.

**Multiple instances spinning up:**
Make sure `--min-instances=1 --max-instances=1` set on the service. With session affinity off, two clients of the same session could hit different instances, breaking the relay.

---

## Cost watch

- Cloud Run (1 instance always on, 1 CPU, 1Gi): ~$10-15/month
- Cloud SQL `db-f1-micro`: ~$10/month
- Egress: free tier covers low traffic
- Container Registry storage: <$1/month

Total at MVP scale: **$20-30/month**.

Scale-up costs jump when you switch to multi-instance (Option B in production-architecture.md): +$15-30/month for shared Redis.

---

## Roll back

```bash
# List revisions
gcloud run revisions list --service=backchannel-broker --region=us-west1

# Route 100% of traffic to a previous revision
gcloud run services update-traffic backchannel-broker \
  --region=us-west1 \
  --to-revisions=backchannel-broker-00007-abc=100
```
