# AWS deployment — `feature/aws-s3-sftp-deploy`

Branch cut from `ee7dd774` (v1.46 tip). Deploys with `docker-compose.aws.yml`,
which is the **contract** for the env var names the code reads — change one side
and you must change the other.

---

## The features are OFF by default — `AWS_PUBLISH_ENABLED`

This branch deploys with the SFTP pull and S3 publish paths **switched off**,
because they are the only two things here that have never completed a round trip
against real AWS. Everything else on the branch is verified.

`AWS_PUBLISH_ENABLED` (default `false`) is read by the frontend, the backend and
the worker from one `.env` line:

| Value | Effect |
| --- | --- |
| `false` (default) | The **From SFTP** tab on New Analysis and the **Publish to S3** button on the results page are **absent from the page** — not greyed out, so there is nothing to discover and ask about. The `/api/sftp/*` and `/api/sessions/:id/publish*` endpoints refuse with **503** naming the flag, and the SFTP-pull and publish **jobs** refuse too, so a queued job that outlives a config change cannot run. |
| `true` | Both appear and behave exactly as built. |

Hiding the UI is not the whole gate: the endpoints and the background jobs each
re-check independently, so a hand-crafted request or a stale queued job is
refused as well.

**Turn it on only after** the CloudFront public-path mapping is confirmed and the
throwaway-domain live test below passes. Note that the live test itself needs the
flag on — set `AWS_PUBLISH_ENABLED=true` for that run.

Also note this branch is deployed **as-is, not merged with `main`**: it does not
include v1.47 (version display) or v1.48 (one-click Fix-all redesign). Known and
accepted.

---

## REQUIRED PRE-LAUNCH GATE — throwaway-domain live test

**Nothing real goes through the SFTP → publish path until this passes.**

Everything in this feature was built and verified without AWS credentials or a
Transfer Family endpoint: the SFTP client, S3 publish and CloudFront
invalidation are unit-tested and typecheck against the real SDKs, but **no code
here has ever completed a round trip against actual AWS**. The first thing to
run once the VM has its IAM role and SFTP access is this end-to-end pass against
a throwaway prefix — not a client domain.

Use a disposable domain value such as `_test-domain`, so everything lands under
`sites/_test-domain/sitemaps/` and touches no client's live sitemaps.

0. **Flag on.** Set `AWS_PUBLISH_ENABLED=true` in `.env` and recreate the
   frontend, backend and worker. Until this is done the controls are absent and
   every endpoint below answers 503 — that is the gate working, not a fault.
1. **Config reachable.** `GET /api/sftp/domains` returns a list (not 503/502).
   A 503 naming `AWS_PUBLISH_ENABLED` means step 0 was missed; a 503 naming
   another variable means that env var is unset; a 502 means the endpoint or
   credentials are wrong.
2. **Pull.** Create a session, `POST /api/sessions/:id/sources/sftp` with the
   throwaway domain. Confirm the expected file count appears in the session and
   parses — the pull is queued, so watch the worker log for
   `sftp pull complete` and check `stored` vs `failed`.
3. **Process.** Run a normal fix/clean over the session so at least one file is
   edited (produces a `fixed-…` stored name) and at least one is deleted. This
   is what exercises the production-filename resolution and the index-drop path.
4. **Preview.** `GET /api/sessions/:id/publish/preview?domain=_test-domain`.
   Check every filename is the **client-facing** name — no `current-`,
   `fixed-…`, or session-id prefixes — and that the deleted file appears under
   `omitted_deleted`, not in `files`.
5. **Publish.** Click **Publish to S3**. Confirm `queued: true`, then
   `s3 publish complete` in the worker log with a non-null `invalidation_id`.
6. **Verify the objects.** `aws s3 ls s3://asap-cms-prod/sites/_test-domain/sitemaps/`
   — the child files and the index are present under their real names, and the
   deleted file's object is **still there** (publish never issues DeleteObject)
   but is **absent from the index**.
7. **Verify the CDN actually serves the new content.** Fetch the index through
   CloudFront (not S3 directly) and confirm it reflects this publish. If it
   serves stale content, the invalidation did not take — check the distribution
   id and that the paths in the invalidation match the keys written.
   Then **fetch one `<loc>` from that index** and confirm it returns the child
   sitemap. That is the check for the storage-vs-served mapping: the `<loc>`
   comes from `PUBLIC_SITEMAP_URL_TEMPLATE`, the object key from
   `S3_SITEMAPS_PREFIX_TEMPLATE`, and nothing in the code links the two. A 404
   here means the template is wrong, which is a **one-line `.env` fix** — set
   `PUBLIC_SITEMAP_URL_TEMPLATE` to the path CloudFront really serves (e.g.
   `https://{domain}/{file}` if it's served at the root) and republish. Do not
   "fix" it by changing the prefix: that would move the objects instead.
8. **Verify the lock under real conditions.** Start a publish for the throwaway
   domain and, while it runs, start another for the same domain: the second must
   return **409** with "someone is already publishing this domain". A publish of
   a *different* domain at the same time must proceed normally.
9. **Clean up.** Delete `sites/_test-domain/` from the bucket.

Only after all nine pass should a real client domain be published.

---

## Required `.env` values

No defaults — deployment fails loudly until each is set. That is deliberate: on
a shared production box, silently starting with a stale or wrong value is worse
than not starting.

| Variable | Notes |
| --- | --- |
| `APP_VERSION` | Image tag **and** the version the UI reports. No fallback. |
| `POSTGRES_PASSWORD` | No longer hardcoded. |
| `ENCRYPTION_KEY` | GSC credential encryption at rest. |
| `NEXTAUTH_SECRET`, `CRON_SECRET` | SEO Desk. |
| `AWS_REGION` | S3 + CloudFront client region. |
| `CLOUDFRONT_DISTRIBUTION_ID` | Invalidation target. |
| `SFTP_HOST`, `SFTP_USERNAME` | AWS Transfer Family. |
| `SEO_DESK_URL` | **Browser-reachable** address. The navbar link is a full-page navigation the user's browser follows, so an internal compose name (`http://seo-desk:3000`) will 404 for everyone. |

Optional, with defaults: `AWS_PUBLISH_ENABLED` (`false` — see the section above),
`SFTP_PORT` (22), `SFTP_PRIVATE_KEY_PATH`
(`/run/secrets/sftp_private_key`), `SFTP_PASSWORD` (empty — fallback used only
when the key file is absent), `SFTP_BASE_PATH` (`sftp-sitemaps-asapsmei`),
`SFTP_MAX_CONCURRENT_CONNECTIONS` (4), `S3_BUCKET` (`asap-cms-prod`),
`S3_SITEMAPS_PREFIX_TEMPLATE` (`sites/{domain}/sitemaps/`),
`PUBLIC_SITEMAP_URL_TEMPLATE` (`https://{domain}/sitemaps/{file}`),
`S3_PUBLISH_ALLOW_DELETE` (`false`), `PUBLISH_LOCK_TTL_SECONDS` (300),
`NODE_TLS_REJECT_UNAUTHORIZED` (1), `FRONTEND_PORT` (3000), `SEO_DESK_PORT`
(4000).

**No AWS access keys anywhere.** S3 and CloudFront use the default provider
chain, which resolves the EC2 instance role. If IAM-role auth is not wired up on
first deploy that is a blocker to fix, not a reason to add keys.

---

## Design decisions worth knowing before changing anything

- **Publish never deletes.** There is no `DeleteObject` call in the codebase. A
  file removed in a session drops out of the regenerated index; its object stays
  in the bucket, unreferenced. Versioning is off, so a wrong delete has no undo.
  `S3_PUBLISH_ALLOW_DELETE=true` is **rejected at runtime** rather than silently
  ignored, so the flag cannot imply a capability that does not exist.
- **Storage layout and public url are separate configs, on purpose.**
  `S3_SITEMAPS_PREFIX_TEMPLATE` decides the object key;
  `PUBLIC_SITEMAP_URL_TEMPLATE` decides the `<loc>` written into the sitemap
  index. `buildPublishIndexXml` is not given the prefix at all, so the key path
  cannot leak back into a public url as it did originally. Only the CloudFront
  distribution knows the true mapping between them, and this code cannot read
  it — so the mapping is configuration, verified by gate step 7, not an
  assumption compiled in. Changing one to match the other is almost always wrong.
- **Publish is per-domain locked, and collisions are rejected, not queued.** Two
  users publishing different domains run fully in parallel. Two publishing the
  same domain: the second gets a 409. Queuing it would overwrite production
  minutes later with nobody watching.
- **One public port.** Only the frontend publishes a port. Browser calls go to a
  relative `/api/backend/*` which Next reverse-proxies server-side to
  `BACKEND_URL`. The backend deliberately publishes **no** port — exposing it
  would put an unauthenticated API on the internet and defeat the design.
  SEO Desk is the one exception: it is a separate app with its own NextAuth
  session, reached by full-page navigation, so it keeps its own published port.
- **Everything is compiled.** Backend runs `node dist/server.js`; the piscina
  pools load `dist/workers/*.js` with no tsx. `tsx watch` on an always-on shared
  box would re-exec the API on any stray file write.
