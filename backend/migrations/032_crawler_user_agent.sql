-- Sampling was failing across every pattern on multiple unrelated domains with
-- HTTP 405 + `x-amzn-waf-action: captcha` from awselb/2.0. Cause: the sampler
-- impersonated Chrome. AWS WAF Bot Control flags a browser User-Agent that
-- arrives without a matching browser fingerprint and serves a CAPTCHA action;
-- the ALB surfaces that as 405 on HEAD *and* GET, which looked like a
-- method/URL problem but was pure UA detection. An honest crawler UA passes.
--
-- sessions.user_agent is captured at session-creation time and reused on every
-- re-sample/resume, so changing the code default alone would leave every
-- existing session permanently stuck on the blocked UA.

ALTER TABLE sessions
  ALTER COLUMN user_agent SET DEFAULT 'Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)';

-- Only rewrite rows still carrying the old built-in default; a UA a user typed
-- in deliberately is left alone.
UPDATE sessions
SET user_agent = 'Mozilla/5.0 (compatible; SitemapHealthChecker/1.0)'
WHERE user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
