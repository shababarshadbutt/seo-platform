import { readFile } from "node:fs/promises";

import SftpClient from "ssh2-sftp-client";

import { config } from "../config.js";

// SFTP input for AWS Transfer Family (Phase 1). Transfer Family speaks real
// SFTP, not the S3 API, so this is a genuine SSH client rather than an S3 call.
//
// Shared-VM discipline: 10+ SEO users can each kick off a pull. Every
// connection is taken from a semaphore capped at SFTP_MAX_CONCURRENT_CONNECTIONS
// so the Transfer Family endpoint (and this box's own sockets/FDs) can't be
// swamped; excess requests QUEUE rather than fail. Connections are opened per
// operation and always closed in a finally — nothing is pooled across requests,
// so a crashed pull can't leak a live SSH session or hold a slot.

export type SftpRemoteFile = {
  name: string;
  size: number;
};

// A fair FIFO semaphore. Callers wait in arrival order, so a burst of pulls is
// served predictably instead of starving whoever asked first.
class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;

      return this.releaseOnce();
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));

    return this.releaseOnce();
  }

  // Guard against a caller releasing twice (which would inflate the limit).
  private releaseOnce(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      const next = this.waiters.shift();

      if (next) {
        next();

        return;
      }

      this.available = Math.min(this.limit, this.available + 1);
    };
  }

  stats() {
    return { available: this.available, queued: this.waiters.length };
  }
}

const semaphore = new Semaphore(config.sftp.maxConcurrentConnections);

export function sftpPoolStats() {
  return {
    limit: config.sftp.maxConcurrentConnections,
    ...semaphore.stats()
  };
}

// Build ssh2 auth options: private key when its file is readable, otherwise the
// password fallback. Throws when neither is usable, so the failure is a clear
// config error rather than an opaque handshake rejection.
async function authOptions(): Promise<{ privateKey?: Buffer; password?: string }> {
  if (config.sftp.privateKeyPath) {
    try {
      return { privateKey: await readFile(config.sftp.privateKeyPath) };
    } catch {
      // Fall through to password — the key file simply isn't mounted here.
    }
  }

  if (config.sftp.password) {
    return { password: config.sftp.password };
  }

  throw new Error(
    `No usable SFTP credential: ${config.sftp.privateKeyPath} is not readable and SFTP_PASSWORD is unset`
  );
}

// Run `work` against a connected SFTP client, holding one pool slot for exactly
// the duration of the operation. The slot and the connection are both released
// in a finally, including on throw.
// How long a disconnect is allowed to take before we stop waiting for it. Much
// shorter than an operation timeout: there is nothing left to accomplish, and the
// only reason to wait at all is politeness to the remote.
const SFTP_DISCONNECT_TIMEOUT_MS = 5000;

// Reject if `promise` has not settled in `ms`. Used to bound every SFTP operation.
//
// Note this does NOT cancel the underlying work — ssh2 offers no cancellation —
// it stops us WAITING on it. That distinction is the whole value here: the pool
// slot is freed even when the socket underneath is wedged, so one bad connection
// degrades one transfer instead of the entire endpoint for every user.
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function withSftp<T>(work: (client: SftpClient) => Promise<T>): Promise<T> {
  const release = await semaphore.acquire();
  const client = new SftpClient();

  try {
    // Both the connect AND the operation are bounded. Either can hang on a
    // half-open socket, and an unbounded await here held a pool slot forever —
    // measured: two wedged transfers left the pool at 0 of 2 available for
    // minutes, blocking every other user of the shared endpoint.
    await withTimeout(
      client.connect({
        host: config.sftp.host,
        port: config.sftp.port,
        username: config.sftp.username,
        ...(await authOptions())
      }),
      config.sftp.operationTimeoutMs,
      "SFTP connect"
    );

    return await withTimeout(
      work(client),
      config.sftp.operationTimeoutMs,
      "SFTP operation"
    );
  } finally {
    // end() can throw OR HANG if the socket already died. It used to be awaited
    // unbounded, directly in front of release() — so a hanging disconnect leaked
    // the slot just as surely as a hanging transfer. Bounded, and its failure
    // cannot skip the release below.
    await withTimeout(
      client.end(),
      SFTP_DISCONNECT_TIMEOUT_MS,
      "SFTP disconnect"
    ).catch(() => {
      // A disconnect we gave up on may leave the socket open. Tear it down
      // explicitly rather than leaking a file descriptor for the process's life;
      // guarded because it reaches past the wrapper to the underlying ssh2
      // client, which is not part of its public contract.
      try {
        (
          client as unknown as { client?: { destroy?: () => void } }
        ).client?.destroy?.();
      } catch {
        // Nothing further to try; the slot release below is what matters.
      }
    });

    // ALWAYS. Every path above is bounded and swallowed precisely so this runs.
    release();
  }
}

// Reject anything that could escape the configured base path. Domains come from
// user input, so "../" and absolute paths must never reach the remote path.
export function assertSafeDomain(domain: string): void {
  if (!domain || domain.includes("/") || domain.includes("\\") || domain.includes("..")) {
    throw new Error("Invalid domain");
  }
}

function remoteDirFor(domain: string): string {
  assertSafeDomain(domain);
  const base = config.sftp.basePath.replace(/^\/+|\/+$/g, "");

  return `/${base}/${domain}`;
}

// The domains available to pull — one directory per domain under the base path.
export async function listSftpDomains(): Promise<string[]> {
  const base = `/${config.sftp.basePath.replace(/^\/+|\/+$/g, "")}`;

  return withSftp(async (client) => {
    const entries = await client.list(base);

    return entries
      .filter((entry) => entry.type === "d")
      .map((entry) => entry.name)
      .filter((name) => name !== "." && name !== "..")
      .sort();
  });
}

// The sitemap files for one domain. Files sit FLAT in <base>/<domain>/ — there
// is no per-type subfolder — so a single non-recursive list is correct.
export async function listSftpSitemapFiles(
  domain: string
): Promise<SftpRemoteFile[]> {
  const dir = remoteDirFor(domain);

  return withSftp(async (client) => {
    const entries = await client.list(dir);

    return entries
      .filter(
        (entry) => entry.type === "-" && /\.xml(\.gz)?$/i.test(entry.name)
      )
      .map((entry) => ({ name: entry.name, size: entry.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

// Download one remote file straight to a local path. fastGet streams to disk,
// so a multi-hundred-MB sitemap never lands in the heap — the same discipline
// the uploads path and the Cleaner already follow.
export async function downloadSftpFile(
  domain: string,
  remoteName: string,
  localPath: string
): Promise<void> {
  assertSafeDomain(domain);

  if (remoteName.includes("/") || remoteName.includes("\\") || remoteName.includes("..")) {
    throw new Error("Invalid remote filename");
  }

  const remotePath = `${remoteDirFor(domain)}/${remoteName}`;

  await withSftp(async (client) => {
    await client.fastGet(remotePath, localPath);
  });
}

export type SftpDownloadOutcome = {
  name: string;
  localPath: string;
  ok: boolean;
  error?: unknown;
};

// Download many files with BOUNDED PARALLELISM.
//
// Both callers (the Cleaner's SFTP source and the Migration SFTP pull) used to
// await one downloadSftpFile at a time. Because every download is its own SSH
// connect + fastGet + end, a sequential loop pays a full round trip per file and
// leaves the connection pool almost entirely idle — measured at 2,264 files, the
// pull was the overwhelming majority of a ~19 minute run while 3 of 4 pool slots
// sat unused.
//
// Concurrency is capped at SFTP_MAX_CONCURRENT_CONNECTIONS, the same limit the
// pool semaphore enforces, and deliberately NOT higher: this is a shared VM and
// a shared Transfer Family endpoint.
//
// It is also capped at exactly that number rather than launching every download
// at once and letting the semaphore queue them. The semaphore is global and FIFO,
// so a run that queues 2,000 waiters would push every other user's request behind
// all of them. Keeping only `limit` in flight per run means a second user's pull
// interleaves after at most `limit` completions instead of waiting out the whole
// batch.
//
// A failed file does not abort the batch — it is reported in its outcome and the
// caller decides, exactly as the sequential loops did.
export async function downloadSftpFiles(
  domain: string,
  files: { name: string; localPath: string }[],
  options: {
    // Awaited, not fire-and-forget: unordered progress writes let a late frame
    // land after the terminal one and clobber it. Same discipline as the publish
    // path, where that defect was already found once.
    onSettled?: (
      outcome: SftpDownloadOutcome,
      completed: number,
      total: number
    ) => void | Promise<void>;
    // Stops the batch between files. Checked BEFORE starting each transfer, so an
    // aborted batch releases its connection-pool slot as soon as the in-flight
    // transfer finishes rather than at the end of the whole run — which is the
    // point: a slot held by an abandoned run starves every other user.
    //
    // Not aborted mid-transfer on purpose: ssh2's fastGet has no cancellation, and
    // tearing the socket down would leave a truncated file on disk that looks like
    // a real sitemap. One file's worth of delay is a fair price for that.
    signal?: AbortSignal;
  } = {}
): Promise<SftpDownloadOutcome[]> {
  assertSafeDomain(domain);

  const total = files.length;
  const outcomes: SftpDownloadOutcome[] = new Array(total);
  let nextIndex = 0;
  let completed = 0;

  const concurrency = Math.max(
    1,
    Math.min(config.sftp.maxConcurrentConnections, total)
  );

  async function worker() {
    for (;;) {
      const index = nextIndex;

      if (index >= total) {
        return;
      }

      // Checked here, not just once up front: an abort that lands mid-batch must
      // stop the REMAINING files, and every worker has to see it.
      if (options.signal?.aborted) {
        return;
      }

      nextIndex += 1;
      const file = files[index];

      try {
        await downloadSftpFile(domain, file.name, file.localPath);
        outcomes[index] = { name: file.name, localPath: file.localPath, ok: true };
      } catch (error) {
        outcomes[index] = {
          name: file.name,
          localPath: file.localPath,
          ok: false,
          error
        };
      }

      // Completion COUNT, not the file's index: with parallel workers the
      // indexes finish out of order, and a progress bar driven by them would
      // jump around and go backwards.
      completed += 1;
      await options.onSettled?.(outcomes[index], completed, total);
    }
  }

  await Promise.all(
    Array.from({ length: concurrency }, () => worker())
  );

  // An abort leaves holes: files the workers never reached. Fill them in as
  // explicit failures rather than returning a sparse array — every caller
  // index-aligns against its input, and a hole would surface as a crash on
  // `outcome.ok` instead of a file that simply did not get downloaded.
  for (let index = 0; index < total; index += 1) {
    if (!outcomes[index]) {
      outcomes[index] = {
        name: files[index].name,
        localPath: files[index].localPath,
        ok: false,
        error: new Error("SFTP download batch was aborted before this file")
      };
    }
  }

  return outcomes;
}
