// Custom status page domains (Pro). Plan: docs/plans/custom-status-domain.md.
//
// The editor section stays hidden until the backend callables, the Cloudflare
// for SaaS setup and the status-domain-proxy Worker are live. Flip to true at
// launch (mirrors CUSTOM_DOMAINS_ENABLED in functions/src/config.ts), nothing
// else needs to change. The custom host entry (CustomDomainApp) is not gated:
// no hostname reaches it until Cloudflare routes one.
export const CUSTOM_DOMAINS_ENABLED = true;

/** Pro includes this many custom domains per account. Mirrors CUSTOM_DOMAIN.maxPerAccount. */
export const MAX_CUSTOM_DOMAINS_PER_ACCOUNT = 10;

/** Customers point a CNAME here. Mirrors CUSTOM_DOMAIN.cnameTarget. */
export const CUSTOM_DOMAIN_CNAME_TARGET = 'domains.exit1.dev';
