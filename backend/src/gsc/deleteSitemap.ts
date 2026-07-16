import { createSign } from "node:crypto";

import { request } from "undici";

// Google Search Console — Sitemaps.delete.
//
// Implemented directly against the REST API rather than pulling in the very
// large `googleapis` package: the whole flow is a service-account JWT exchanged
// for an OAuth2 access token, then a single authenticated DELETE. This keeps the
// backend image lean and has no runtime dependency beyond undici + node:crypto.
//
//   DELETE https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps/{feedpath}
//
// Auth scope: https://www.googleapis.com/auth/webmasters

export type ServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

export type GscDeleteResult = { success: boolean; error?: string };

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_TTL_SECONDS = 3600;
const HTTP_TIMEOUT_MS = 15000;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Parse and validate a service-account JSON key. Throws with a friendly message
// so a bad paste surfaces as a clear per-file error rather than a stack trace.
export function parseServiceAccount(raw: string): ServiceAccountCredentials {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("credentials are not valid JSON");
  }

  const value = parsed as Record<string, unknown>;

  if (
    typeof value.client_email !== "string" ||
    typeof value.private_key !== "string"
  ) {
    throw new Error(
      "credentials must be a service account JSON with client_email and private_key"
    );
  }

  return {
    client_email: value.client_email,
    private_key: value.private_key,
    token_uri:
      typeof value.token_uri === "string" ? value.token_uri : DEFAULT_TOKEN_URI
  };
}

// Exchange a service-account key for a short-lived OAuth2 access token using the
// JWT bearer grant (RS256-signed assertion).
async function getAccessToken(
  credentials: ServiceAccountCredentials,
  nowSeconds: number
): Promise<string> {
  const tokenUri = credentials.token_uri ?? DEFAULT_TOKEN_URI;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: GSC_SCOPE,
      aud: tokenUri,
      iat: nowSeconds,
      exp: nowSeconds + TOKEN_TTL_SECONDS
    })
  );

  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();

  let signature: string;

  try {
    signature = base64Url(signer.sign(credentials.private_key));
  } catch {
    throw new Error("failed to sign JWT — private_key is invalid");
  }

  const assertion = `${signingInput}.${signature}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion
  }).toString();

  const response = await request(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    headersTimeout: HTTP_TIMEOUT_MS,
    bodyTimeout: HTTP_TIMEOUT_MS
  });

  const text = await response.body.text();

  if (response.statusCode < 200 || response.statusCode >= 300) {
    let message = `token request failed with status ${response.statusCode}`;

    try {
      const payload = JSON.parse(text) as {
        error_description?: string;
        error?: string;
      };
      message = payload.error_description ?? payload.error ?? message;
    } catch {
      // keep the status-based message
    }

    throw new Error(message);
  }

  const payload = JSON.parse(text) as { access_token?: string };

  if (!payload.access_token) {
    throw new Error("token response did not include an access_token");
  }

  return payload.access_token;
}

// Submit a sitemap deletion request to Google Search Console.
// `propertyUrl` is the GSC property (site) URL; `sitemapUrl` is the full public
// URL of the sitemap being removed. Never throws — always resolves to a result
// so a failure for one file does not abort a batch.
export async function deleteFromGSC(
  propertyUrl: string,
  sitemapUrl: string,
  credentials: ServiceAccountCredentials,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<GscDeleteResult> {
  try {
    const accessToken = await getAccessToken(credentials, nowSeconds);
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
      propertyUrl
    )}/sitemaps/${encodeURIComponent(sitemapUrl)}`;

    const response = await request(endpoint, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
      headersTimeout: HTTP_TIMEOUT_MS,
      bodyTimeout: HTTP_TIMEOUT_MS
    });

    const text = await response.body.text();

    // GSC returns 204 No Content on success.
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { success: true };
    }

    let message = `GSC delete failed with status ${response.statusCode}`;

    try {
      const payload = JSON.parse(text) as { error?: { message?: string } };

      if (payload.error?.message) {
        message = payload.error.message;
      }
    } catch {
      // keep the status-based message
    }

    return { success: false, error: message };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "GSC request failed"
    };
  }
}
