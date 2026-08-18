# Sitemap Migration Health Checker

Local Docker MVP for SEO teams to upload an XML sitemap, group migrated URL
patterns, sample live URLs, review health, revisit past sessions, and export
CSV, Excel, or PDF reports.

Detailed product and engineering notes live in
[`docs/requirements.md`](docs/requirements.md).

## Run the Full Stack

```powershell
docker compose up --build
```

Open the frontend:

```text
http://localhost:3010
```

## Ports

| Service | Port | Notes |
| --- | ---: | --- |
| Frontend | `3010` | Next.js app |
| Backend | `3011` | Fastify API |
| Worker | `3002` | Internal worker health port |
| PostgreSQL | `5432` | Local database |
| Redis | `6380` | Mapped away from the default `6379` |

Health checks:

```text
http://localhost:3010/api/health
http://localhost:3011/health
```

## First Analysis

1. Go to `http://localhost:3010`.
2. Enter a session name and the migrated site base URL.
3. Upload one or more current `.xml` sitemap files, and optionally add legacy
   sitemap files for old/new pattern comparison.
4. Choose sample size and max simultaneous checks, then start the analysis.
5. Wait for processing to complete, then review results or export CSV, Excel, or PDF.

## Environment Variables

| Variable | Description |
| --- | --- |
| `FRONTEND_PORT` | Host port for the Next.js frontend. Default in this project: `3010`. |
| `BACKEND_PORT` | Host port for the Fastify API. Default in this project: `3011`. |
| `BACKEND_URL` | Where the frontend's `/api/backend/*` proxy forwards to. Set by the compose files to `http://backend:3001`; not a per-deployment knob. A frontend without it answers 502 on every backend call and 503 on `/api/health`. |
| `SEO_DESK_URL` | Browser-reachable address of the SEO Desk app, for the navbar link. Read at runtime, so it must not be a `NEXT_PUBLIC_*` value or an internal compose hostname. |
| `AWS_PUBLISH_ENABLED` | Master flag for the SFTP-pull and S3-publish paths. `false` (default) removes the "From SFTP" tab and the Publish-to-S3 button from the page entirely and makes their endpoints answer 503. Only the exact string `true` enables it, and it must be set for the frontend, backend and worker together. |
| `POSTGRES_PORT` | Host port for PostgreSQL. Default: `5432`. |
| `REDIS_PORT` | Host port for Redis. Default in this project: `6380`. |
| `POSTGRES_USER` | PostgreSQL username used by the database container. |
| `POSTGRES_PASSWORD` | PostgreSQL password used by the database container. |
| `POSTGRES_DB` | PostgreSQL database name. |
| `DATABASE_URL` | Backend/worker database connection string. |
| `REDIS_URL` | Backend/worker Redis connection string. |
| `UPLOAD_DIR` | Container path where uploaded sitemaps are stored. |
| `EXPORT_DIR` | Container path where generated exports are saved. |
| `FRONTEND_URL` | Internal URL the backend uses for PDF rendering. |
| `PDF_BACKEND_URL` | Backend URL used by the PDF renderer inside Docker. |
| `CHROMIUM_PATH` | Chromium executable path for backend PDF generation. |
| `DEFAULT_HTTP_USER_AGENT` | Optional User-Agent override for URL sampling requests. |
| `PATTERN_URL_POOL_MULTIPLIER` | Optional tuning value for pattern sampling candidate pools. |
| `PATTERN_URL_POOL_MIN_SIZE` | Optional minimum pattern sampling candidate pool size. |

## Known Limitations

- One session represents one current-site analysis, with optional legacy sitemap
  comparison.
- No authentication or user roles.
- Built for local Docker usage only.
- PDF export depends on Chromium inside the backend container.
- Soft-404 detection uses a lightweight GET body sample after successful HEAD checks.
- Malformed sitemaps keep completed `<loc>` entries for partial pattern extraction.

## Troubleshooting

### Redis Port Conflict

If another Redis is already using `6379`, keep this project mapped to `6380`:

```env
REDIS_PORT=6380
```

Then restart:

```powershell
docker compose down
docker compose up --build
```

### Frontend or Backend Port Conflict

If another project is using `3000` or `3001`, use the host ports in `.env`:

```env
FRONTEND_PORT=3010
BACKEND_PORT=3011
```

The frontend reaches the backend through its own `/api/backend/*` proxy, which
reads `BACKEND_URL` from the compose file at request time — so changing
`BACKEND_PORT` needs no frontend rebuild. To check what a running frontend
actually got, `curl` its `/api/health`: a 503 naming `BACKEND_URL` means the
container was started without the environment it needs (most often by using
`docker-compose.yml` where the deployed box needs `docker-compose.aws.yml`).

### Backend Is Unreachable From the UI

Make sure Docker is running and the backend container is healthy:

```powershell
docker compose ps
curl http://localhost:3011/health
```

### Rebuild After Dependency Changes

If the UI or export behavior looks stale after code changes:

```powershell
docker compose up -d --build backend frontend worker
```
