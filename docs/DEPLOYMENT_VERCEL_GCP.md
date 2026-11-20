# Sales Master: Vercel frontend and Google Cloud backend

Prepared on 14 November 2026. The files in this repository are prepared for this arrangement; cloud resources have not been created or deployed.

## Architecture

| Component | Where it runs |
| --- | --- |
| React/Vite frontend | Vercel, project root directory `frontend` |
| Django REST API | Google Cloud Run, built from `backend/Dockerfile` |
| Production database | Cloud SQL for PostgreSQL |
| Private visit photos | Cloud Storage; image access still goes through the authenticated Django API |
| Passwords and Django secret | Secret Manager |
| Migrations and maintenance | Cloud Run Jobs |

Cloud Run's container filesystem is temporary. Use PostgreSQL and Cloud Storage for persistent records and uploads; do not upload the local SQLite database into the container. Google's [Django deployment guide](https://docs.cloud.google.com/python/django/run) describes this service arrangement.

The frontend now reads `VITE_API_URL` for login, token refresh, API calls, downloads and photos. Leave it empty locally to use Vite's development proxy; set it to the Cloud Run **origin**, for example `https://sales-master-api-EXAMPLE.asia-south1.run.app`, on Vercel. Do not append `/api`. Vite embeds this value at build time, so changing it requires a new frontend deployment. Never put passwords or keys in a `VITE_` variable. [Vite environment variable documentation](https://vite.dev/guide/env-and-mode).

## 1. Local data cleanup and account preservation

The approved local cleanup has removed extra users, sample dealers, visits, orders, follow-ups, products, assignments and GPS/tracking records. The remaining login accounts are:

| Username | Role |
| --- | --- |
| `admin` | Admin; existing superuser account retained |
| `demo@sunkool.in` | Salesman; existing salesman profile retained |

Their existing password hashes, account IDs and retained salesman profile are preserved. The demo login is its **username**, `demo@sunkool.in`; no email-address change was made.

A full pre-cleanup SQLite backup is in `backend/.backups/before_demo_cleanup_*.sqlite3`. The two accounts and the demo profile have also been exported to `backend/.backups/bootstrap-users.json` for initial production setup. Both are excluded from Git, Docker and Cloud Build uploads. The export contains password hashes: transfer it privately, not through a Git commit.

For reference, these commands run from `backend` in Windows PowerShell:

```powershell
# Preview only; never changes data.
.\.venv\Scripts\python manage.py clean_local_demo_data

# Export the cleaned accounts and profile again when required.
.\.venv\Scripts\python manage.py dumpdata accounts.user accounts.salesman --natural-foreign --indent 2 --output .backups/bootstrap-users.json
```

`clean_local_demo_data --apply` is a deliberate reset of **all local business data**, with a verified backup first. It is restricted to SQLite files inside `backend`, and refuses PostgreSQL/Cloud SQL. Do not run it after entering real records. Automated tests create their own test database; their fixtures are not production seed data.

## 2. Google Cloud project and tools

Use a Google Cloud project with billing enabled. Cloud SQL, Cloud Run, storage and build services can incur charges. Select instance sizes and a billing budget in the console before creating resources; this guide does not assume a free deployment.

The following commands are **Bash commands for Google Cloud Shell**, not PowerShell. Open Cloud Shell, clone your actual application repository, and work from its root. Replace `YOUR_PROJECT_ID` and the Vercel hostname below. `asia-south1` is the Mumbai example; keep the backend, database and bucket in your chosen region.

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="asia-south1"
export SERVICE="sales-master-api"
export SQL_INSTANCE="sales-master-db"
export BUCKET="${PROJECT_ID}-sunkool-private"
export RUNTIME_SA="sales-master-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
export IMAGE_TAG="release-001"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/sales-master/backend:${IMAGE_TAG}"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com iam.googleapis.com cloudscheduler.googleapis.com
gcloud artifacts repositories create sales-master --repository-format=docker --location="$REGION"
gcloud iam service-accounts create sales-master-runtime --display-name="Sales Master backend"
```

The person deploying needs permission to build images, administer Cloud Run and its jobs, and act as the runtime service account. Ensure the project's Cloud Build service account can push to the Artifact Registry repository. These are deployment permissions; do not grant project Owner to the runtime account. [Cloud Run deployment documentation](https://docs.cloud.google.com/run/docs/deploying).

## 3. PostgreSQL database

In **Google Cloud Console → SQL → Create instance → PostgreSQL**:

1. Name the instance `sales-master-db`, use PostgreSQL 16 or a supported compatible version, and select the same region as Cloud Run.
2. Choose an instance size for your budget. Enable automatic backups and point-in-time recovery for production.
3. For the socket connection used here, enable the instance's public IP. Cloud Run connects through the Cloud SQL integration and authenticated proxy; do not add `0.0.0.0/0` to authorized networks. Private-IP-only instances require VPC connectivity, which is a separate configuration.
4. Create a database named `sales_master` and an application database user named `sales_master`. Choose its password in the console.
5. Copy the instance connection name, in the form `PROJECT:REGION:sales-master-db`.

In Cloud SQL Studio, connect to `sales_master` as the database administrator and allow the application user to create Django's tables:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO sales_master;
```

```bash
export SQL_CONNECTION="$(gcloud sql instances describe "$SQL_INSTANCE" --format='value(connectionName)')"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${RUNTIME_SA}" --role="roles/cloudsql.client"
```

The backend's `INSTANCE_CONNECTION_NAME` is `PROJECT:REGION:sales-master-db`; Django connects through the `/cloudsql/<INSTANCE_CONNECTION_NAME>` socket. Both the web service and every database job need the Cloud SQL attachment. [Connecting Cloud Run to Cloud SQL](https://docs.cloud.google.com/sql/docs/postgres/connect-run).

## 4. Private photos and secrets

Create the photo bucket and grant the runtime identity access to objects in that bucket only:

```bash
gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${RUNTIME_SA}" --role="roles/storage.objectAdmin"
```

The Cloud settings use the runtime service account automatically; no downloaded service-account JSON key is needed. Do not make the bucket public. The application reads photo bytes using Django storage and returns them only after its existing authorization check. [Bucket creation](https://docs.cloud.google.com/storage/docs/creating-buckets), [Django Google Cloud Storage backend](https://django-storages.readthedocs.io/en/latest/backends/gcloud.html).

In **Secret Manager**, create these secrets and their first versions:

| Secret name | Value |
| --- | --- |
| `sales-master-django-secret` | A newly generated random Django secret, at least 50 characters |
| `sales-master-db-password` | The password of the `sales_master` PostgreSQL user |

Enter values in Secret Manager rather than pasting passwords into deployment commands. Grant the runtime account access to these two secrets:

```bash
for SECRET in sales-master-django-secret sales-master-db-password; do
  gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor"
done
export RUNTIME_SECRETS="DJANGO_SECRET_KEY=sales-master-django-secret:1,DB_PASSWORD=sales-master-db-password:1"
```

The examples pin secret version `1`. Use the actual enabled version when rotating secrets or deploying a later release. [Cloud Run secret configuration](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

## 5. Configure and build the backend

Copy `backend/cloudrun.env.yaml.example` to `backend/cloudrun.env.yaml`, then replace every `YOUR-...` value. This file contains non-secret configuration; passwords come from Secret Manager.

| Setting | Required value |
| --- | --- |
| `INSTANCE_CONNECTION_NAME` | The actual instance connection name (`PROJECT:REGION:sales-master-db`) |
| `DB_NAME`, `DB_USER` | The database and user created above (`DB_PASSWORD` comes from Secret Manager) |
| `GS_BUCKET_NAME` | The private photo bucket's name, without `gs://` |
| `FRONTEND_URLS` | Exact Vercel/custom frontend origins, separated by commas; used for both CORS and CSRF |
| `ALLOWED_HOSTS` | Initially `.run.app`; narrow to the service hostname after the first deployment |

The Docker image selects `config.settings_cloud`, installs `requirements-cloud.txt`, serves Django with Gunicorn on `$PORT`, and collects Django/admin static assets into the image using WhiteNoise. Dummy values used for static collection are build-only values; runtime secrets are not baked into the image. Production settings require PostgreSQL configuration and a bucket instead of silently falling back to SQLite. [WhiteNoise Django setup](https://whitenoise.readthedocs.io/en/stable/django.html).

From the repository root in Cloud Shell:

```bash
gcloud builds submit backend --tag "$IMAGE"
```

The backend `.gcloudignore` and `.dockerignore` exclude local databases, uploads, backups, `.env` files and the virtual environment.

## 6. Run database migrations once per release

Create/update a one-task Cloud Run Job using the same image, database attachment, configuration and secrets as the service:

```bash
gcloud run jobs deploy sales-master-migrate \
  --image="$IMAGE" --region="$REGION" --service-account="$RUNTIME_SA" \
  --set-cloudsql-instances="$SQL_CONNECTION" \
  --env-vars-file=backend/cloudrun.env.yaml --set-secrets="$RUNTIME_SECRETS" \
  --command=python --args=manage.py,migrate,--noinput \
  --tasks=1 --parallelism=1 --max-retries=0 --memory=512Mi --cpu=1

gcloud run jobs execute sales-master-migrate --region="$REGION" --wait
```

Wait for success before deploying the web revision. Migrations are not run on every web-container startup. [Creating Cloud Run Jobs](https://docs.cloud.google.com/run/docs/create-jobs), [job deployment flags](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy), [executing jobs](https://docs.cloud.google.com/run/docs/execute/jobs).

## 7. Deploy the API

```bash
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" --region="$REGION" --service-account="$RUNTIME_SA" \
  --add-cloudsql-instances="$SQL_CONNECTION" \
  --env-vars-file=backend/cloudrun.env.yaml --set-secrets="$RUNTIME_SECRETS" \
  --allow-unauthenticated --port=8080 \
  --min-instances=0 --max-instances=1 --concurrency=8 \
  --memory=512Mi --cpu=1 --timeout=120

export SERVICE_URL="$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo "$SERVICE_URL"
gcloud run services update "$SERVICE" --region="$REGION" --update-env-vars="ALLOWED_HOSTS=${SERVICE_URL#https://}"
```

Public HTTP invocation allows the browser to reach login and the JWT-protected API. It does not remove Django authentication. If an organization policy prohibits public Cloud Run services, ask the project administrator to select the supported access arrangement before deploying.

Update the hostname in `backend/cloudrun.env.yaml` too, so the next release keeps the narrowed setting. To add a backend custom domain later, include its hostname in `ALLOWED_HOSTS` and use its HTTPS origin in the frontend configuration.

Start with the single worker and instance shown here: Django currently uses a process-local cache for throttling. Configure a shared cache before increasing worker or instance counts if you need shared login/upload/GPS rate limits.

## 8. Import only the two existing accounts into a fresh production database

This is a **one-time** bootstrap after migrations, while the Cloud SQL application database contains no user accounts or business data. Do not import this fixture into an established database: it preserves local account/profile IDs and password hashes. Do not copy SQLite itself into Cloud Run.

Use Cloud Shell's **Upload file** action to privately upload `backend/.backups/bootstrap-users.json` from your computer as `bootstrap-users.json`. Create a temporary secret from that uploaded file:

```bash
gcloud secrets create sales-master-bootstrap-users --data-file=bootstrap-users.json
gcloud secrets add-iam-policy-binding sales-master-bootstrap-users --member="serviceAccount:${RUNTIME_SA}" --role="roles/secretmanager.secretAccessor"

gcloud run jobs deploy sales-master-bootstrap \
  --image="$IMAGE" --region="$REGION" --service-account="$RUNTIME_SA" \
  --set-cloudsql-instances="$SQL_CONNECTION" \
  --env-vars-file=backend/cloudrun.env.yaml \
  --set-secrets="${RUNTIME_SECRETS},/bootstrap/users.json=sales-master-bootstrap-users:1" \
  --command=python --args=manage.py,loaddata,/bootstrap/users.json \
  --tasks=1 --parallelism=1 --max-retries=0 --memory=512Mi --cpu=1

gcloud run jobs execute sales-master-bootstrap --region="$REGION" --wait
```

The secret file is mounted only in the bootstrap job, not in the web service. After successful login verification, disable the bootstrap job's temporary secret version and remove the uploaded copy from Cloud Shell. Keep the local backup somewhere private. Do not run this job on future releases. [Secret file mounting](https://docs.cloud.google.com/run/docs/configuring/services/secrets).

## 9. Deploy the frontend on Vercel

Import the actual application Git repository into Vercel and configure:

| Vercel setting | Value |
| --- | --- |
| Root Directory | `frontend` |
| Framework | Vite |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Environment Variable | `VITE_API_URL` = the actual `SERVICE_URL`, without `/api` |

Set the variable for Production before deploying. Use a separate backend/database for preview deployments when possible; add an exact preview origin to backend CORS only when you intend it to use that backend.

`frontend/vercel.json` supplies the SPA fallback, so refreshing `/dealers`, `/my-dealers/5` or `/visit-history` loads React instead of returning Vercel 404. Requests go directly to Cloud Run using `VITE_API_URL`; no Vercel API proxy is required. [Vercel Vite deployment and SPA routing](https://vercel.com/docs/frameworks/frontend/vite).

If the final Vercel/custom hostname differs from the one in the backend YAML, update `FRONTEND_URLS` there and update/redeploy the API. A CORS error is resolved with the exact frontend origin, not with `*`.

## 10. Verify the live deployment

1. Open Vercel `/login`, sign in as `admin` using its existing password, and check that sample dealers, orders and extra salesmen are absent.
2. Sign out, open `/login`, and sign in as `demo@sunkool.in` using its existing password. The account should have its salesman profile and an empty dealer book.
3. Refresh a nested React route. Check the browser Network panel: API requests must go to Cloud Run and must return JSON rather than Vercel's `index.html`.
4. Record an intended visit with the required photos. Verify that the photo can still be opened after a new backend revision is deployed; its bytes must be in the private bucket.
5. Test report downloads and login/token refresh. The Cloud backend exposes `Content-Disposition` through CORS so export filenames remain available.
6. Confirm that the database backup schedule is enabled and inspect Cloud Run/Jobs logs for errors.

## 11. Maintenance and later releases

Create separate one-task Cloud Run Jobs, with the migration job's image, service account, Cloud SQL attachment, YAML and secrets, for:

| Job command (`python manage.py ...`) | Schedule, Asia/Kolkata |
| --- | --- |
| `close_stale_sessions` | Every 15 minutes |
| `purge_location_data` | Daily |
| `purge_orphan_photos` | Daily |

Use Cloud Scheduler's Cloud Run Job integration. Scheduler needs an authorized service account to invoke the jobs; do not add public HTTP endpoints that run cleanup commands. See [scheduling Cloud Run Jobs](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule).

For a release: commit/push the code, choose a new `IMAGE_TAG`, rebuild, run migrations, deploy the new API image, then let Vercel deploy the frontend. Keep schema changes compatible with the previous revision during rollout. Cloud Run revision rollback does not undo database migrations; restore a database backup only as a separate, planned operation.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Login returns HTML / JSON parse error | Vercel `VITE_API_URL` was absent at build time; set it and redeploy |
| API responds 400 / `DisallowedHost` | Exact backend hostname in `ALLOWED_HOSTS` |
| Browser blocks API calls | Exact frontend origin in `FRONTEND_URLS` |
| Cloud Run container fails to start | Secret access, required variables, startup logs and `$PORT` binding |
| Database connection fails | Cloud SQL Client role, instance attachment, socket path, database username/password |
| Photos fail or disappear | Bucket name, object permissions, and `config.settings_cloud` selection |
| Django admin has no CSS | Docker `collectstatic` step and WhiteNoise static files |
| Gunicorn fails when run directly on Windows | Run it in the Linux container/Cloud Run; use Django's development server locally |

The cloud infrastructure, container execution and real Vercel/Cloud Run integration must be verified in your Google Cloud and Vercel projects. Local application tests alone do not verify cloud IAM, billing, DNS or runtime provisioning.
