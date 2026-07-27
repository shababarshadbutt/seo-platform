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
async function withSftp<T>(work: (client: SftpClient) => Promise<T>): Promise<T> {
  const release = await semaphore.acquire();
  const client = new SftpClient();

  try {
    await client.connect({
      host: config.sftp.host,
      port: config.sftp.port,
      username: config.sftp.username,
      ...(await authOptions())
    });

    return await work(client);
  } finally {
    // end() can throw if the socket already died; that must not mask the real
    // error or skip the semaphore release.
    await client.end().catch(() => undefined);
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
