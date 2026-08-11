-- Which request profile produced this sample's verdict (v1.59).
--
-- WHY PERSIST IT. When the primary profile (the session's own user_agent) is
-- confirmed blocked, checkSampleUrl retries the whole check with
-- BROWSER_FALLBACK_PROFILE — the Chrome UA from config.ts plus four Sec-Fetch-*
-- headers. Without recording which attempt won, a pattern that NEEDED the browser
-- profile looks identical in the data to one that never did.
--
-- That distinction is the point rather than trivia. There is no single correct UA
-- across the 650+ sites this tool checks: migration 032 documented a site where a
-- browser UA tripped AWS WAF Bot Control and the honest crawler UA passed, and
-- stackedindustrials.com is the exact reverse. Knowing WHICH sites consistently
-- require the browser profile is how that landscape gets understood over time
-- instead of re-litigated per incident — and it should not have to be re-derived
-- from log greps.
--
-- NULLABLE with no default, deliberately: existing rows predate the retry and
-- genuinely have no answer, which is different from "false" (primary profile
-- worked). NULL = unknown/never applicable, false = primary succeeded, true = the
-- fallback produced this verdict.
ALTER TABLE sampled_urls
  ADD COLUMN IF NOT EXISTS used_fallback_profile BOOLEAN;

COMMENT ON COLUMN sampled_urls.used_fallback_profile IS
  'TRUE when the verdict came from the browser fallback profile after the primary profile was blocked. FALSE when the primary profile answered. NULL for rows written before the fallback existed.';
