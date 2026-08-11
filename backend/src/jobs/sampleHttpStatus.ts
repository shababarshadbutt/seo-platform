// Pure status-classification helpers for the sampled-URL checker.
//
// Deliberately its OWN module with no imports: samplePatternsJob transitively
// pulls in sessionCompletion -> preGenerateZipQueue, which opens a BullMQ/Redis
// connection at module load. Importing the job from a unit test therefore hangs
// the test process forever. Keeping the pure predicates here makes them testable
// without standing up Redis.

// 405 Method Not Allowed and 501 Not Implemented are statements about the REQUEST
// METHOD, not about the page. Plenty of origins, CDNs, WAFs and inspection
// proxies refuse HEAD while serving GET perfectly well — and because the checker
// probes with HEAD, every sampled URL behind such a host came back as a
// "failure", which reads in the UI as the pages being Broken. That is a false
// negative, and a URL-rewriting fix applied on top of it would be acting on a
// wrong diagnosis.
//
// Deliberately narrow. 403/429/503 are NOT re-probed: those are about
// authorisation, rate limiting and availability, and retrying them with GET would
// hide a real signal rather than correct a bogus one.
export function isMethodRejectedStatus(statusCode: number | null): boolean {
  return statusCode === 405 || statusCode === 501;
}

// Response headers that mean an inspection proxy / WAF intervened in this
// request, rather than the origin answering for itself.
//
// PRESENCE IS THE SIGNAL, not the value. x-amzn-waf-action can read "captcha",
// "challenge" or "block"; all of them mean the same thing for our purposes — the
// response we are looking at was manufactured by the WAF, so its status code says
// nothing about whether the page works.
//
// Kept as a named list of CONFIRMED headers so adding a second vendor later is one
// line. x-amzn-waf-action is the only one measured on real traffic here (the
// original 405-captcha investigation). Speculative vendor headers are deliberately
// absent: a wrong entry here silently reclassifies genuine failures as blocked,
// which is the failure mode this whole change exists to avoid in the other
// direction.
const WAF_BLOCK_HEADERS = ["x-amzn-waf-action"];

export function hasWafBlockHeader(
  headers: Record<string, string | string[] | undefined>
): boolean {
  return WAF_BLOCK_HEADERS.some((name) => {
    // undici lower-cases response header names, but a caller passing raw Node
    // headers should not silently miss — check case-insensitively.
    const direct = headers[name];

    if (direct !== undefined) {
      return true;
    }

    return Object.keys(headers).some(
      (key) => key.toLowerCase() === name && headers[key] !== undefined
    );
  });
}
