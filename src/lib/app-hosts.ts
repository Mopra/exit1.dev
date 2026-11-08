// Which hostnames serve the full exit1 app, and which are a customer's custom
// status page domain (proxied by the status-domain-proxy Worker). On a custom
// domain main.tsx renders CustomDomainApp: no Clerk, no Clarity, no GA.
// index.html has a matching hostname guard around the gtag loader.

/** True for hosts that run the full app (Clerk, Clarity, GA). */
export function isAppHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === '' || h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;
  if (h === 'exit1.dev' || h.endsWith('.exit1.dev')) return true;
  if (h.endsWith('.web.app') || h.endsWith('.firebaseapp.com')) return true;
  return false;
}

/**
 * The custom hostname this page is served on, or null on an app host.
 * In dev, `?customHost=status.example.com` simulates one on localhost, and
 * `?customHostPage=<statusPageId>` skips the Firestore lookup so a page
 * without a connected domain can be previewed.
 */
export function customHostFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  if (import.meta.env.DEV) {
    const simulated = new URLSearchParams(window.location.search).get('customHost');
    if (simulated) return simulated.toLowerCase();
  }
  const host = window.location.hostname;
  return isAppHost(host) ? null : host.toLowerCase().replace(/\.$/, '');
}

/** Dev only: status page id to render on a simulated custom host without a lookup. */
export function devCustomHostPageId(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('customHostPage');
}
