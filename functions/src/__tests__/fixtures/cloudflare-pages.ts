/**
 * Cloudflare page fixtures shared by the WAF detection tests.
 * CF_BLOCK_BODY is trimmed from the real page served for jcinsulationsa.com
 * (error 1020 style WAF block) on 2026-09-15.
 */

export const CF_BLOCK_BODY = `<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head>
<title>Attention Required! | Cloudflare</title>
<meta charset="UTF-8" />
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css" />
</head>
<body>
  <div id="cf-wrapper">
    <div id="cf-error-details" class="p-0">
      <h1>Sorry, you have been blocked</h1>
      <h2>You are unable to access jcinsulationsa.com</h2>
    </div>
  </div>
</body>
</html>`;

/** Legacy JS challenge page (no cf-mitigated header on older variants). */
export const CF_CHALLENGE_BODY = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=abc"></script></head><body></body></html>`;

/** Cloudflare-branded error page for an origin 503: same template, not a block. */
export const CF_ORIGIN_503_BODY = `<!DOCTYPE html>
<html class="no-js" lang="en-US">
<head>
<title>example.com | 503: Service Unavailable</title>
<link rel="stylesheet" id="cf_styles-css" href="/cdn-cgi/styles/cf.errors.css" />
</head>
<body>
  <div id="cf-wrapper">
    <div id="cf-error-details" class="p-0">
      <h1>Service Unavailable</h1>
      <h2>Error code 503</h2>
    </div>
  </div>
</body>
</html>`;

/** An ordinary origin 403 into which Bot Management's JavaScript Detections injected its script. */
export const ORIGIN_403_WITH_JSD_BODY = `<html><head><title>Members only</title></head>
<body><p>Please log in.</p>
<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/abcdef/main.js"></script></body></html>`;
