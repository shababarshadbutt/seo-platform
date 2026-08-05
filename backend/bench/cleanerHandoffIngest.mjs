// Drive the Cleaner -> Migration handoff at scale and time the ingest.
//
// It exists because "Start Migration Analysis" after a large clean failed with a
// bare "Server error — fetch failed", and nothing on either side recorded where
// the time went: POST /api/sessions/:id/sources/cleaner copied and inserted every
// cleaned file in one sequential loop inside one HTTP request.
//
// Runs the REAL flow, because that is the only way to get a handoff token: clean N
// generated sitemaps via POST /api/cleaner/process (reading its SSE for the
// download_token), create a session, then POST the handoff and time it.
//
// Usage:
//   node backend/bench/cleanerHandoffIngest.mjs <fileCount> [urlsPerFile] [--proxy]
//
// --proxy sends the handoff through the frontend's /api/backend proxy (port 3010)
// instead of straight at the backend (3011). That distinction is the whole point:
// the backend sets no handler timeout (Fastify leaves server.timeout and
// requestTimeout at 0), so a slow ingest only fails when something in FRONT of it
// gives up.
const FILES = Number(process.argv[2] ?? 3500);
const URLS = Number(process.argv[3] ?? 20);
const VIA_PROXY = process.argv.includes("--proxy");

const BACKEND = process.env.BENCH_BACKEND ?? "http://localhost:3011";
const PROXY = process.env.BENCH_PROXY ?? "http://localhost:3010/api/backend";
const HANDOFF_BASE = VIA_PROXY ? PROXY : BACKEND;
const DOMAIN = "bench-handoff.example.com";
const DOMAIN_URL = `https://${DOMAIN}`;

const seconds = (ms) => (ms / 1000).toFixed(1);

// Bytes of extra path per <loc>. The ingest cost this bench targets is per-FILE
// (copyFile + a root-element peek + one INSERT), so it scales with file BYTES,
// while the Cleaner's own parse/dedup scales with URL COUNT. Padding the URLs
// buys large files without a 40M-URL clean becoming the slow part of the setup —
// which would measure the wrong thing.
const PAD = Number(
  process.argv.find((a) => a.startsWith("--pad="))?.slice(6) ?? 0
);

function urlset(index) {
  const urls = [];
  const pad = PAD > 0 ? `/${"s".repeat(PAD)}` : "";

  for (let i = 0; i < URLS; i += 1) {
    urls.push(
      `  <url><loc>https://${DOMAIN}/p/${index}/${i}${pad}</loc><lastmod>2026-01-01</lastmod></url>`
    );
  }

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join("\n") +
    "\n</urlset>\n"
  );
}

// Read an SSE body and return the terminal frame.
async function readSse(response, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = null;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");

    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));

      if (!line) {
        continue;
      }

      const frame = JSON.parse(line.slice(6));

      last = frame;
      onFrame?.(frame);
    }
  }

  return last;
}

async function clean() {
  const form = new FormData();

  form.set("domain", DOMAIN_URL);
  form.set("subfolder", "sitemaps");
  form.set("fileCount", String(FILES));

  for (let i = 0; i < FILES; i += 1) {
    form.append(
      "files",
      new Blob([urlset(i)], { type: "application/xml" }),
      `sitemap-${String(i).padStart(5, "0")}.xml`
    );
  }

  process.stdout.write(`cleaning ${FILES} files (${URLS} urls each)...\n`);
  const started = Date.now();
  const response = await fetch(`${BACKEND}/api/cleaner/process`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    throw new Error(`clean failed: ${response.status} ${await response.text()}`);
  }

  let lastStage = "";
  const done = await readSse(response, (frame) => {
    if (frame.stage && frame.stage !== lastStage) {
      lastStage = frame.stage;
      process.stdout.write(`  stage=${frame.stage}\n`);
    }
  });

  if (!done?.download_token) {
    throw new Error(`no download_token in terminal frame: ${JSON.stringify(done)}`);
  }

  process.stdout.write(`cleaned in ${seconds(Date.now() - started)}s\n`);

  return done.download_token;
}

async function createSession() {
  const response = await fetch(`${BACKEND}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `handoff-bench-${FILES}`,
      base_url: `https://${DOMAIN}`,
      sample_size: 5
    })
  });
  const body = await response.json();

  if (!body.session_id) {
    throw new Error(`no session_id: ${JSON.stringify(body)}`);
  }

  return body.session_id;
}

async function handoff(sessionId, token) {
  process.stdout.write(
    `\nPOST ${HANDOFF_BASE}/api/sessions/:id/sources/cleaner (${
      VIA_PROXY ? "THROUGH PROXY" : "DIRECT to backend"
    })\n`
  );

  const started = Date.now();

  try {
    const response = await fetch(
      `${HANDOFF_BASE}/api/sessions/${sessionId}/sources/cleaner`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token })
      }
    );
    const text = await response.text();

    process.stdout.write(
      `RESULT status=${response.status} after ${seconds(Date.now() - started)}s\n` +
        `body: ${text.slice(0, 400)}\n`
    );
  } catch (error) {
    // This is the failure the user reported: the message the proxy would put in
    // its 502 body, verbatim.
    process.stdout.write(
      `THREW after ${seconds(Date.now() - started)}s\n` +
        `  name=${error.name} message=${error.message}\n` +
        `  cause=${error.cause?.name ?? "-"} / ${error.cause?.message ?? "-"} / code=${
          error.cause?.code ?? "-"
        }\n`
    );
  }
}

// A completed handoff is asynchronous now, so report where it got to.
async function pollIngest(sessionId) {
  for (let i = 0; i < 240; i += 1) {
    const response = await fetch(
      `${BACKEND}/api/sessions/${sessionId}/sources/cleaner/status`
    );

    if (response.status === 404) {
      return;
    }

    const body = await response.json();

    process.stdout.write(
      `  ingest ${body.status} ${body.current ?? 0}/${body.total ?? 0}\n`
    );

    if (body.status === "COMPLETE" || body.status === "FAILED" || body.status === "NONE") {
      return;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }
}

const token = await clean();
const sessionId = await createSession();

process.stdout.write(`session=${sessionId}\n`);
await handoff(sessionId, token);

if (process.argv.includes("--poll")) {
  await pollIngest(sessionId);
}

process.stdout.write(`\nsession_id=${sessionId}\n`);
