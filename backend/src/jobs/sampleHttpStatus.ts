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
