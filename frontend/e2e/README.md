# Manual browser checks

Playwright scripts for behaviour that only exists in the rendered UI, where a
passing typecheck proves nothing. Run by hand against a live stack — not wired
into CI, because they need Postgres, Redis, a frontend, and an SFTP source.

## landing-and-sftp-autofill.mjs

Covers:

- the app lands on the **Cleaner** at `/`, and Migration is still reachable at
  `/migration` from the navbar;
- selecting a domain on the **From SFTP** tab **fills the Base URL field**, with
  a `www.` folder yielding a `www.` Base URL;
- a hand-edited Base URL that differs only by `www.` is **not** flagged (both
  spellings resolve to one S3 publish prefix), while a genuinely different host
  **is** flagged;
- the History page renders the storage-reclamation panel.

## staging-check-mode.mjs

The 1.90 / 2.0 URL-check toggle. Covers:

- the toggle **renders in the navbar** with both modes labelled by ENVIRONMENT,
  not as bare version numbers (next to a version pill reading `v1.90`, a bare
  "1.90" is unreadable);
- the **Staging Base URL** field previews the derived `dev.<domain>` as its
  placeholder while you type a Base URL, and is available even while the toggle
  sits at 1.90 (a session created at 1.90 must still be able to carry one);
- switching **to** 2.0 **confirms first**, and the dialog states all three true
  things: the blast radius, that re-checking replaces stored production results,
  and that the setting is global;
- confirming **actually persists** 2.0 server-side.

It sets the mode back to 1.90 on the way out — a check that silently left every
health check pointed at staging would be worse than no check.

Needs only the standard stack below (no SFTP source):

```sh
SHOT_DIR=./shots node e2e/staging-check-mode.mjs
```

### Running it

```sh
# 1. services
POSTGRES_PORT=5434 docker compose up -d postgres redis

# 2. an SFTP source with one directory per domain
docker run -d --name verify_sftp -p 2222:22 \
  -v "$PWD/tmp-sftp:/home/svc/sftp-sitemaps-asapsmei" \
  atmoz/sftp:alpine "svc:verifypass:::"

# 3. backend + worker. EXPORT_DIR/UPLOAD_DIR must be real paths — the defaults
#    are container paths (/uploads, /exports) and fail on a host run.
cd backend
DATABASE_URL=postgresql://sitemap:sitemap@localhost:5434/sitemap_health \
REDIS_URL=redis://localhost:6380 \
UPLOAD_DIR=$PWD/../tmp-uploads EXPORT_DIR=$PWD/../tmp-exports \
AWS_PUBLISH_ENABLED=true AWS_REGION=us-east-1 S3_BUCKET=verify-bucket \
SFTP_HOST=127.0.0.1 SFTP_PORT=2222 SFTP_USERNAME=svc SFTP_PASSWORD=verifypass \
SFTP_PRIVATE_KEY_PATH=/nonexistent PORT=3011 npx tsx src/server.ts

# 4. frontend
cd frontend
AWS_PUBLISH_ENABLED=true BACKEND_URL=http://localhost:3011 \
  npx next dev --hostname 127.0.0.1 --port 3010

# 5. the checks
SHOT_DIR=./shots node e2e/landing-and-sftp-autofill.mjs
```

Exits non-zero on the first failed assertion and writes screenshots to
`$SHOT_DIR`.
