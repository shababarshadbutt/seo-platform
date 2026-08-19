import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The two compose files must declare the SAME env contract.
//
// docker-compose.yml says so in its own header — "If you add a variable the
// frontend, backend or worker reads at runtime, add it to BOTH files" — and that
// rule was prose only, so it had already been broken twice by the time this test
// was written:
//
//   * the whole Phase 1 block (SFTP_*, S3_*, AWS_REGION, CLOUDFRONT_*) and the
//     PRIVATE_* private-VPC block were in the aws file and absent from the dev
//     one, while AWS_PUBLISH_ENABLED was in BOTH. So a dev stack with the flag on
//     showed the "From SFTP" tab and the Publish-to-S3 button, and every one of
//     those endpoints answered 503 "SFTP is not configured on this deployment
//     (SFTP_HOST is unset)". The UI offered a control the API refused.
//   * CLOUDFRONT_WILDCARD_THRESHOLD and CLOUDFRONT_MAX_PATHS_PER_REQUEST were
//     added to the aws file only, in the very commit that introduced them.
//
// This is a worse failure than the v1.63-Live outage the header describes. There
// the flag was missing too, so the tab silently vanished — fail-closed. Here the
// flag arrives without its config, so the feature appears and then refuses.
//
// Deliberately a plain line parser rather than a YAML library: the backend has no
// yaml dependency, and adding one to assert a two-file invariant is a worse trade
// than 30 lines of parsing. The compose files are machine-uniform here — one
// `KEY: value` per line at a fixed indent — so this reads them exactly.

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/src -> backend -> repo root
const REPO_ROOT = path.resolve(HERE, "..", "..");

// Services whose env the app reads at runtime. postgres/redis/mongo/seo-desk are
// deliberately excluded: they are third-party images configured independently in
// each environment, not consumers of this app's config.
const APP_SERVICES = ["frontend", "backend", "worker"];

// Keys allowed to differ, with the reason. NODE_ENV is the environment's own
// identity — "development" in the dev file, "production" in the aws one — so
// requiring it to match would be requiring the two files to be the same file.
const ALLOWED_TO_DIFFER = new Set(["NODE_ENV", "DEPLOYMENT_PROFILE"]);

// The literal value of one env var in one service, or null when absent. Used by
// the DEPLOYMENT_PROFILE tests, which are about the VALUE rather than the key.
function envValue(
  composePath: string,
  service: string,
  key: string
): string | null {
  const lines = readFileSync(composePath, "utf8").split(/\r?\n/);
  let current: string | null = null;
  let inEnvironment = false;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    const serviceMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);

    if (serviceMatch) {
      current = serviceMatch[1];
      inEnvironment = false;
      continue;
    }

    const sectionMatch = /^ {4}([A-Za-z0-9_-]+):/.exec(line);

    if (sectionMatch) {
      inEnvironment = sectionMatch[1] === "environment";
      continue;
    }

    if (inEnvironment && current === service) {
      const varMatch = new RegExp(`^ {6}${key}:\\s*(.*)$`).exec(line);

      if (varMatch) {
        return varMatch[1].trim();
      }
    }
  }

  return null;
}

// Env keys declared per service, keyed by service name.
function envKeysByService(composePath: string): Map<string, Set<string>> {
  const lines = readFileSync(composePath, "utf8").split(/\r?\n/);
  const result = new Map<string, Set<string>>();

  let inServices = false;
  let service: string | null = null;
  let inEnvironment = false;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }

    // Top-level key: `services:`, `volumes:`, `x-logging:` …
    if (/^\S/.test(line)) {
      inServices = line.startsWith("services:");
      service = null;
      inEnvironment = false;
      continue;
    }

    if (!inServices) {
      continue;
    }

    // A service name, at two spaces.
    const serviceMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);

    if (serviceMatch) {
      service = serviceMatch[1];
      inEnvironment = false;
      result.set(service, new Set());
      continue;
    }

    // A key of the service, at four spaces: `environment:`, `volumes:`, `image:` …
    const sectionMatch = /^ {4}([A-Za-z0-9_-]+):/.exec(line);

    if (sectionMatch) {
      inEnvironment = sectionMatch[1] === "environment";
      continue;
    }

    // An env var, at six spaces, while inside `environment:`.
    if (inEnvironment && service) {
      const varMatch = /^ {6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);

      if (varMatch) {
        result.get(service)?.add(varMatch[1]);
      }
    }
  }

  return result;
}

const dev = envKeysByService(path.join(REPO_ROOT, "docker-compose.yml"));
const aws = envKeysByService(path.join(REPO_ROOT, "docker-compose.aws.yml"));

// Guard the parser itself. If it silently matched nothing, every assertion below
// would pass vacuously and this file would be worse than no test at all.
test("the compose parser actually found both files' app services", () => {
  for (const [label, parsed] of [
    ["docker-compose.yml", dev],
    ["docker-compose.aws.yml", aws]
  ] as const) {
    for (const service of APP_SERVICES) {
      const keys = parsed.get(service);

      assert.ok(keys, `${label}: no service named ${service} was parsed`);
      assert.ok(
        (keys?.size ?? 0) > 3,
        `${label}: ${service} parsed only ${keys?.size ?? 0} env vars — the parser is broken, not the file`
      );
    }
  }

  // A key known to be in both, as a positive control on the parse.
  assert.ok(dev.get("backend")?.has("AWS_PUBLISH_ENABLED"));
  assert.ok(aws.get("backend")?.has("AWS_PUBLISH_ENABLED"));
});

test("docker-compose.yml declares every env var docker-compose.aws.yml does", () => {
  for (const service of APP_SERVICES) {
    const devKeys = dev.get(service) ?? new Set<string>();
    const awsKeys = aws.get(service) ?? new Set<string>();

    const missing = [...awsKeys]
      .filter((key) => !devKeys.has(key) && !ALLOWED_TO_DIFFER.has(key))
      .sort();

    assert.deepEqual(
      missing,
      [],
      `${service}: docker-compose.aws.yml declares ${missing.length} var(s) that docker-compose.yml does not — ` +
        `${missing.join(", ")}. A var present in one file and not the other means the dev stack ` +
        `either cannot use the feature or, worse, shows its UI and refuses the request. Add it to both.`
    );
  }
});

// The reverse direction matters just as much: a var only the dev file sets is one
// the DEPLOYED box will not have, which is how a feature that works locally
// breaks in production.
test("docker-compose.aws.yml declares every env var docker-compose.yml does", () => {
  for (const service of APP_SERVICES) {
    const devKeys = dev.get(service) ?? new Set<string>();
    const awsKeys = aws.get(service) ?? new Set<string>();

    const missing = [...devKeys]
      .filter((key) => !awsKeys.has(key) && !ALLOWED_TO_DIFFER.has(key))
      .sort();

    assert.deepEqual(
      missing,
      [],
      `${service}: docker-compose.yml declares ${missing.length} var(s) that docker-compose.aws.yml does not — ` +
        `${missing.join(", ")}. These would be absent on the deployed box.`
    );
  }
});

// The specific pairing that produced the reported bug: the flag that REVEALS the
// SFTP and publish UI must never travel without the config those features need.
// Asserted by name, in both files, so the combination cannot recur silently even
// if someone widens ALLOWED_TO_DIFFER.
test("the AWS feature flag never ships without the config it enables", () => {
  const REQUIRED_WITH_FLAG = [
    "SFTP_HOST",
    "SFTP_USERNAME",
    "SFTP_BASE_PATH",
    "AWS_REGION",
    "S3_BUCKET",
    "PUBLIC_SITEMAP_URL_TEMPLATE",
    "CLOUDFRONT_DISTRIBUTION_ID"
  ];

  for (const [label, parsed] of [
    ["docker-compose.yml", dev],
    ["docker-compose.aws.yml", aws]
  ] as const) {
    for (const service of ["backend", "worker"]) {
      const keys = parsed.get(service) ?? new Set<string>();

      if (!keys.has("AWS_PUBLISH_ENABLED")) {
        continue;
      }

      for (const required of REQUIRED_WITH_FLAG) {
        assert.ok(
          keys.has(required),
          `${label}: ${service} sets AWS_PUBLISH_ENABLED but not ${required}. ` +
            `Turning the flag on then shows the "From SFTP" tab and the Publish-to-S3 button ` +
            `while the endpoints answer 503 naming this variable.`
        );
      }
    }
  }
});

// DEPLOYMENT_PROFILE is the one variable whose whole job is to DIFFER between the
// two files, so the contract tests above exempt it — which means it needs its own
// assertions or it would be the least-checked variable in the file.
//
// It exists because both compose files default to the same compose project name
// (the directory), so `docker compose up` without -f on the deployed VM replaces
// the production containers with dev-file ones. The only symptom was
// /api/sftp/* answering 503 "SFTP_HOST is unset" on a box whose .env plainly set
// SFTP_HOST, and nothing the deployment reported could tell that apart from a
// genuine config mistake.
test("both compose files stamp a DEPLOYMENT_PROFILE on every app service", () => {
  for (const [label, parsed] of [
    ["docker-compose.yml", dev],
    ["docker-compose.aws.yml", aws]
  ] as const) {
    for (const service of APP_SERVICES) {
      assert.ok(
        (parsed.get(service) ?? new Set()).has("DEPLOYMENT_PROFILE"),
        `${label}: ${service} has no DEPLOYMENT_PROFILE, so a container built from it cannot say which file it came from`
      );
    }
  }
});

test("the two files report DIFFERENT profiles, as literals", () => {
  const devPath = path.join(REPO_ROOT, "docker-compose.yml");
  const awsPath = path.join(REPO_ROOT, "docker-compose.aws.yml");

  for (const service of APP_SERVICES) {
    const devProfile = envValue(devPath, service, "DEPLOYMENT_PROFILE");
    const awsProfile = envValue(awsPath, service, "DEPLOYMENT_PROFILE");

    assert.equal(devProfile, "dev", `docker-compose.yml ${service}`);
    assert.equal(awsProfile, "aws", `docker-compose.aws.yml ${service}`);

    // The point of the whole marker: the two can never claim the same identity.
    assert.notEqual(
      devProfile,
      awsProfile,
      `${service}: both files report the same profile, so the marker cannot distinguish them`
    );

    // A LITERAL, not a ${...} substitution. It names the FILE, so allowing .env
    // to override it would let a dev-file container claim to be the aws one —
    // which is exactly the confusion it was added to end.
    for (const [label, value] of [
      ["docker-compose.yml", devProfile],
      ["docker-compose.aws.yml", awsProfile]
    ] as const) {
      assert.ok(
        value !== null && !value.includes("$"),
        `${label}: ${service}'s DEPLOYMENT_PROFILE is ${value} — it must be a literal, not overridable from .env`
      );
    }
  }
});
