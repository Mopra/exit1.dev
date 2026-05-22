import React from 'react';
import { PublicPageHeader } from '@/components/layout';

interface ReleaseNote {
  date: string;       // ISO yyyy-mm-dd
  title: string;
  summary?: string;
  items: string[];
}

// Newest first. Edit here when shipping.
const releaseNotes: ReleaseNote[] = [
  {
    date: '2026-05-22',
    title: 'Live Charts & Real-Time Engine',
    summary:
      'A brand-new live chart powered by streaming probe data — pan, zoom, and inspect every request as it happens.',
    items: [
      'Rebuilt live chart on uPlot with fluid scroll and probe-aligned ticks',
      'Phase-timing breakdown (DNS, Connect, TLS, TTFB) on every probe',
      'Brush navigator and drag-to-zoom for historical windows',
      'Probe table with NDJSON export and bidirectional selection between chart and table',
      'Maintenance and disabled windows now appear as state-segment bands',
      'WebSocket-authoritative live updates with smoother countdown UX',
      'Disable/enable now flows through a dedicated action with Power icons',
    ],
  },
  {
    date: '2026-05-15',
    title: 'Multi-Region Confirmation, Domain Checks & Bulk Import Polish',
    summary:
      'Kill single-region false positives, monitor pure domains, and import checks faster.',
    items: [
      'Multi-region peer confirmation gate before firing DOWN alerts — eliminates single-region false positives',
      'Standalone domain-only check type for WHOIS and expiry monitoring without HTTP',
      'Adaptive SSL refresh cadence based on days until expiry',
      'Type-first bulk CSV import flow with per-type templates and hints',
      'Searchable filter bar with folder colors and type icons',
      '7-day+ stats route through daily summaries for much faster history loads',
      '20 additional TLD WHOIS servers and improved column parsing',
      'Password changes delegated to the Clerk user profile; lifted 50-character name cap',
    ],
  },
  {
    date: '2026-04-30',
    title: 'Theme Refresh & Boston Region',
    summary:
      'A polished new look from top to bottom, plus US-East monitoring for Pro and Agency plans.',
    items: [
      'Refreshed palette, typography, and surface elevation across the app',
      'All colors centralized as CSS tokens — stage colors, aurora effects, favicon, and PDF receipts now themed in one place',
      'New vps-us-1 (Boston) region available to Pro and Agency tiers',
      'Per-check region override for routing specific checks to specific regions',
      'API Keys page redesign with folder-color helpers',
    ],
  },
  {
    date: '2026-04-28',
    title: 'New Plan Lineup, Map & Folder Views, Webhook Presets',
    summary:
      'Plans restructured to Free / Nano / Pro / Agency, with new check views and alert integrations.',
    items: [
      'New plan lineup: Free, Nano, Pro, and Agency (replacing the previous Scale tier)',
      'Map view and folder view for organising and visualising checks',
      'PagerDuty, Opsgenie, and Pumble webhook presets',
      'Onboarding flow with a guided "run your first check" step, persisted server-side so it follows you across devices',
      'In-app feedback widget and founders upgrade flow',
      'Shift-click bulk selection and bulk move-to-folder',
    ],
  },
  {
    date: '2026-04-17',
    title: 'Alert Reliability & Email Inbox Rewrite',
    summary: 'Fewer false alerts, smarter retries, and a completely rebuilt Emails page.',
    items: [
      'System-wide health gate and per-user circuit breaker to catch alert storms',
      'Webhook retry circuit breaker and throttle for flapping checks',
      'Post-deploy grace handling — UP alerts fire immediately while transient blips are suppressed',
      'Plain-text email format option alongside HTML',
      'Redirect chain following in HTTP checks; bulk CSV import now supports redirect validation',
      'Redesigned Emails page with progressive disclosure, mobile cards, filter bar, and folder grouping',
      "Global search and a public stats counter powering the marketing site's live metric",
    ],
  },
  {
    date: '2026-04-09',
    title: 'DNS, Heartbeat & Embeddable Status Badges',
    summary:
      'Three new ways to monitor: DNS records, heartbeat pings, and status badges you can embed anywhere.',
    items: [
      'DNS monitoring with baseline change detection across A, AAAA, MX, TXT, NS, and CNAME records',
      'Heartbeat (push) checks with unique ping URLs and token rotation',
      'Embeddable SVG status badges — status, uptime, and response-time variants',
      'Script-embed snippets with mandatory exit1.dev backlink (removable on paid tiers)',
      'Badge analytics in the admin dashboard',
      '"Powered by exit1.dev" footer on public status pages',
      'Fastly edge POP detection in latency breakdowns',
    ],
  },
  {
    date: '2026-03-28',
    title: 'Scale Tier & 15-Second Checks',
    summary:
      'New Scale plan with sub-minute check intervals and a completely redesigned check engine for maximum speed.',
    items: [
      'New Scale tier with 15-second and 30-second check intervals',
      'Continuous worker pool replaces batch scheduler for real-time check execution',
      'Redesigned check form with single-page side panels and consistent styling',
      'Read-only MCP server for AI assistant integration',
    ],
  },
  {
    date: '2026-03-14',
    title: 'Ping, WebSocket & Redirect Monitoring',
    summary: 'Three new check types to monitor more than just HTTP endpoints.',
    items: [
      'ICMP Ping monitoring with multi-packet checks and TTL tracking',
      'WebSocket (WS/WSS) monitoring for real-time services',
      'Redirect checker to monitor HTTP redirect chains',
      'Response time threshold alerts when latency exceeds your limit',
    ],
  },
  {
    date: '2026-03-06',
    title: 'VPS Infrastructure & Public API',
    summary:
      'All checks now run on dedicated VPS infrastructure for faster, more reliable monitoring. Plus a new write API and guided onboarding.',
    items: [
      'All checks consolidated onto dedicated VPS with static IP for allowlisting',
      'Public API write endpoints with scoped API keys',
      'Guided onboarding flow for new users',
      'Mobile-optimized UI for iPhone SE and small screens',
      'Plan downgrade enforcement with upgrade banners',
    ],
  },
  {
    date: '2026-02-20',
    title: 'Maintenance Mode & Status Widgets',
    summary:
      'Schedule maintenance windows to suppress alerts, and embed status widgets anywhere.',
    items: [
      'Scheduled and recurring maintenance windows for checks',
      'Embeddable status widgets for external sites',
      'WHOIS lookup integration for domain intelligence',
      'Drag-and-drop check reordering with dnd-kit',
      'Check filter mode and folder-level controls',
    ],
  },
  {
    date: '2026-02-06',
    title: 'New Regions, Retention & Alert Upgrades',
    summary:
      'Expanded global coverage with new monitoring regions, smarter data retention, and richer alert details.',
    items: [
      'New monitoring regions with per-check region override',
      'Tier-based data retention policies',
      'Latency breakdown in alert notifications',
      'Notification timezone support',
      'Status codes included in alert emails',
      'Webhook limits and upgrade prompts per plan',
    ],
  },
  {
    date: '2026-01-31',
    title: 'Status Pages & Bulk Operations',
    summary:
      'Redesigned status pages with drag-and-drop layouts and new bulk management tools for checks.',
    items: [
      'Custom drag-and-drop status page layouts',
      'Public status page API with folder-based check grouping',
      'Bulk edit settings across all checks',
      'Bulk CSV import for checks',
      'Tier-based check interval limits',
    ],
  },
  {
    date: '2026-01-25',
    title: 'Domain Intelligence & Multi-Recipient Alerts',
    summary:
      'Monitor domain and SSL certificate expiry alongside uptime, and route alerts to multiple recipients.',
    items: [
      'Domain Intelligence: domain and SSL certificate expiry monitoring',
      'Multiple email and phone recipients per alert',
      'Incident links and deep linking in email alerts',
      'Improved webhook retry logic',
    ],
  },
  {
    date: '2026-01-07',
    title: 'SMS Notifications & Check History',
    summary:
      'Get alerted via SMS, view detailed per-stage timing, and organize checks with log notes.',
    items: [
      'SMS alert notifications',
      'Per-stage timing metrics in check history (DNS, connect, TLS, TTFB)',
      'Log notes and manual log entries',
      'Check limit increased from 100 to 200',
    ],
  },
  {
    date: '2025-12-22',
    title: 'Billing & Configuration Improvements',
    summary: 'Enhanced billing experience and check configuration system.',
    items: [
      'Improved billing UI with receipt configuration',
      'Check defaults system for easier setup',
      'Enhanced logs empty state and BigQuery integration',
      'Check form and table improvements',
      'Backend function optimizations',
    ],
  },
  {
    date: '2025-12-21',
    title: 'Check Views & Release Notes',
    summary: 'New visualization options for monitoring checks.',
    items: [
      'Timeline view for checks',
      'Map view for geographic monitoring',
      'Folder organization for checks',
    ],
  },
  {
    date: '2025-12-04',
    title: 'Notification System',
    summary: 'Real-time notifications and user alerts.',
    items: ['In-app notification bell', 'Rich text editor for notifications', 'User notification preferences'],
  },
  {
    date: '2025-11-29',
    title: 'Security & Badge Features',
    summary: 'Enhanced security monitoring and badge system.',
    items: ['Security refresh system', 'Badge buffer for status pages'],
  },
  {
    date: '2025-10-08',
    title: 'Badge API & Public Status',
    summary: 'Public-facing status pages and badge system.',
    items: ['Public status page API', 'Embeddable status badges', 'Admin user management'],
  },
  {
    date: '2025-10-03',
    title: 'Email Throttling',
    summary: 'Smarter email alert management.',
    items: ['24-hour email throttling window'],
  },
  {
    date: '2025-09-26',
    title: 'Webhooks & Getting Started',
    summary: 'Webhook integration and onboarding improvements.',
    items: ['Enhanced webhook functionality', 'Getting started guide'],
  },
  {
    date: '2025-08-07',
    title: 'UI Overhaul',
    summary: 'Complete redesign with modern components.',
    items: ['shadcn/ui component library', 'New sidebar navigation', 'Webhook management UI'],
  },
  {
    date: '2025-08-01',
    title: 'BigQuery & Performance',
    summary: 'Advanced analytics and performance improvements.',
    items: ['BigQuery integration for logs', 'Performance optimizations', 'Caching improvements'],
  },
  {
    date: '2025-07-28',
    title: 'Statistics & Redesign',
    summary: 'Comprehensive statistics dashboard and UI refresh.',
    items: ['Statistics page', 'Complete redesign'],
  },
  {
    date: '2025-07-20',
    title: 'Authentication & Major Refactor',
    summary: 'User authentication and component restructure.',
    items: ['User authentication system', 'Component restructure'],
  },
  {
    date: '2025-05-08',
    title: 'Initial Release',
    summary: 'Launch of exit1.dev monitoring platform.',
    items: [
      'Website uptime monitoring',
      'Real-time status dashboard',
      'Distributed Firestore-based checking',
      'Developer console',
    ],
  },
];

function getReleaseId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

const ReleaseNotes: React.FC = () => {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <PublicPageHeader />

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto w-full max-w-[680px] px-5 sm:px-8 pt-12 sm:pt-24 pb-20 sm:pb-32">
          {/* Hero */}
          <header className="mb-16 sm:mb-24">
            <div className="text-sm text-muted-foreground mb-3">Changelog</div>
            <h1 className="text-4xl sm:text-5xl font-medium tracking-tight text-foreground">
              What's new
            </h1>
            <p className="mt-4 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-lg">
              Every release, improvement, and fix we ship to exit1.dev.
            </p>
          </header>

          {/* Releases */}
          <div>
            {releaseNotes.map((release, idx) => {
              const id = getReleaseId(release.title);
              const isLatest = idx === 0;
              const isLast = idx === releaseNotes.length - 1;
              return (
                <article
                  key={id}
                  id={id}
                  className="scroll-mt-20 sm:scroll-mt-24 py-12 sm:py-16 border-t border-border/60 first:border-t-0 first:pt-0"
                >
                  <div className="flex items-center gap-2.5 mb-4">
                    {isLatest && (
                      <span
                        aria-hidden
                        className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
                      />
                    )}
                    <time
                      dateTime={release.date}
                      className="text-sm text-muted-foreground"
                    >
                      {formatDate(release.date)}
                    </time>
                    {isLatest && (
                      <span className="text-sm text-primary">Latest</span>
                    )}
                  </div>

                  <h2 className="text-2xl sm:text-[28px] font-medium tracking-tight text-foreground leading-snug">
                    <a
                      href={`#${id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        history.replaceState(null, '', `#${id}`);
                        document
                          .getElementById(id)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      className="text-foreground hover:text-primary transition-colors"
                    >
                      {release.title}
                    </a>
                  </h2>

                  {release.summary && (
                    <p className="mt-4 text-base text-muted-foreground leading-relaxed">
                      {release.summary}
                    </p>
                  )}

                  {release.items.length > 0 && (
                    <ul className="mt-6 space-y-3">
                      {release.items.map((item, i) => (
                        <li
                          key={i}
                          className="flex gap-3 text-[15px] leading-relaxed text-foreground/85"
                        >
                          <span
                            aria-hidden
                            className="select-none text-muted-foreground/50 shrink-0"
                          >
                            —
                          </span>
                          <span className="min-w-0">{item}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Closing flourish on the very last entry */}
                  {isLast && (
                    <div className="mt-12 text-sm text-muted-foreground/70">
                      That's the beginning. Thanks for being here.
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
};

export default ReleaseNotes;
