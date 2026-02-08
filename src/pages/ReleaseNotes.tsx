import React, { useState } from 'react';
import { PageContainer, PublicPageHeader, PageHeader } from '@/components/layout';
import { Sparkles, Calendar } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, ScrollArea, Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui';

interface ReleaseNote {
  date: string;
  title: string;
  content: React.ReactNode;
}

// Release notes data - easily updateable
const releaseNotes: ReleaseNote[] = [
  {
    date: '2026-02-06',
    title: 'New Regions, Retention & Alert Upgrades',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Expanded global coverage with new monitoring regions, smarter data retention, and richer alert details.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>New monitoring regions with per-check region override</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Tier-based data retention policies</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Latency breakdown in alert notifications</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Notification timezone support</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Status codes included in alert emails</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Webhook limits and upgrade prompts per plan</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2026-01-31',
    title: 'Status Pages & Bulk Operations',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Redesigned status pages with drag-and-drop layouts and new bulk management tools for checks.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Custom drag-and-drop status page layouts</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Public status page API with folder-based check grouping</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Bulk edit settings across all checks</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Bulk CSV import for checks</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Tier-based check interval limits</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2026-01-25',
    title: 'Domain Intelligence & Multi-Recipient Alerts',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Monitor domain and SSL certificate expiry alongside uptime, and route alerts to multiple recipients.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Domain Intelligence: domain and SSL certificate expiry monitoring</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Multiple email and phone recipients per alert</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Incident links and deep linking in email alerts</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Improved webhook retry logic</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2026-01-07',
    title: 'SMS Notifications & Check History',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Get alerted via SMS, view detailed per-stage timing, and organize checks with log notes.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>SMS alert notifications</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Per-stage timing metrics in check history (DNS, connect, TLS, TTFB)</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Log notes and manual log entries</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Check limit increased from 100 to 200</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-12-22',
    title: 'Billing & Configuration Improvements',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Enhanced billing experience and check configuration system.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Improved billing UI with receipt configuration</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Check defaults system for easier setup</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Enhanced logs empty state and BigQuery integration</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Check form and table improvements</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Backend function optimizations</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-12-21',
    title: 'Check Views & Release Notes',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          New visualization options for monitoring checks.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Timeline view for checks</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Map view for geographic monitoring</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Folder organization for checks</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-12-04',
    title: 'Notification System',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Real-time notifications and user alerts.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>In-app notification bell</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Rich text editor for notifications</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>User notification preferences</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-11-29',
    title: 'Security & Badge Features',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Enhanced security monitoring and badge system.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Security refresh system</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Badge buffer for status pages</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-10-08',
    title: 'Badge API & Public Status',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Public-facing status pages and badge system.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Public status page API</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Embeddable status badges</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Admin user management</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-10-03',
    title: 'Email Throttling',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Smarter email alert management.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>24-hour email throttling window</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-09-26',
    title: 'Webhooks & Getting Started',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Webhook integration and onboarding improvements.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Enhanced webhook functionality</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Getting started guide</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-08-07',
    title: 'UI Overhaul',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Complete redesign with modern components.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>shadcn/ui component library</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>New sidebar navigation</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Webhook management UI</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-08-01',
    title: 'BigQuery & Performance',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Advanced analytics and performance improvements.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>BigQuery integration for logs</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Performance optimizations</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Caching improvements</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-07-28',
    title: 'Statistics & Redesign',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Comprehensive statistics dashboard and UI refresh.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Statistics page</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Complete redesign</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-07-20',
    title: 'Authentication & Major Refactor',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          User authentication and component restructure.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>User authentication system</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Component restructure</span>
          </li>
        </ul>
      </>
    ),
  },
  {
    date: '2025-05-08',
    title: 'Initial Release',
    content: (
      <>
        <p className="mb-4 text-muted-foreground">
          Launch of exit1.dev monitoring platform.
        </p>
        <ul className="space-y-2 list-none pl-0">
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Website uptime monitoring</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Real-time status dashboard</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Distributed Firestore-based checking</span>
          </li>
          <li className="flex items-start">
            <span className="mr-3">•</span>
            <span>Developer console</span>
          </li>
        </ul>
      </>
    ),
  },
];

// Generate ID from release title
function getReleaseId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const ReleaseNotes: React.FC = () => {
  const [navOpen, setNavOpen] = useState(false);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  function navigateTo(id: string) {
    setNavOpen(false);
    window.setTimeout(() => scrollToId(id), 350);
  }

  const NavContent = (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="px-2 text-xs font-medium text-muted-foreground">Releases</div>
        {releaseNotes.map((release) => {
          const id = getReleaseId(release.title);
          return (
            <Button
              key={id}
              variant="ghost"
              className="w-full justify-start gap-2 cursor-pointer"
              onClick={() => navigateTo(id)}
            >
              <Calendar className="h-4 w-4 shrink-0" />
              <span className="truncate text-sm">{release.title}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <PublicPageHeader />

      {/* Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <PageContainer className="overflow-visible">
          <PageHeader 
            title="What's New" 
            description="Keep up with the latest releases, improvements, and fixes"
            icon={Sparkles}
            actions={
              <Sheet open={navOpen} onOpenChange={setNavOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" className="cursor-pointer md:hidden">
                    Browse releases
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  className="w-[320px] sm:w-[380px] p-0 bg-sky-950/40 backdrop-blur border-sky-500/20"
                >
                  <div className="px-6 pt-6 pb-4 border-b border-sky-500/20">
                    <SheetHeader className="space-y-1">
                      <SheetTitle>Release Notes</SheetTitle>
                      <div className="text-sm text-muted-foreground">Navigate releases</div>
                    </SheetHeader>
                  </div>

                  <ScrollArea className="h-[calc(100vh-7.5rem)]">
                    <div className="px-6 py-4">{NavContent}</div>
                  </ScrollArea>
                </SheetContent>
              </Sheet>
            }
          />

          <div className="max-w-7xl px-4 lg:px-22 pt-10">
              <div className="grid gap-6 md:grid-cols-[280px_1fr]">
              <aside className="hidden md:block md:sticky md:top-16 md:self-start">
                <Card className="border-sky-500/30 bg-sky-500/5 backdrop-blur">
                  <CardHeader className="space-y-3">
                    <CardTitle className="text-base">Releases</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="pr-1">{NavContent}</div>
                  </CardContent>
                </Card>
              </aside>

              <div className="min-w-0 space-y-16">
                {releaseNotes.map((release, index) => {
                  const id = getReleaseId(release.title);
                  return (
                    <article 
                      key={index} 
                      id={id}
                      className="space-y-4 scroll-mt-24"
                    >
                      <time className="text-sm text-muted-foreground block">
                        {formatDate(release.date)}
                      </time>
                      <h2 className="text-2xl font-semibold leading-tight">
                        {release.title}
                      </h2>
                      <div className="prose prose-sm max-w-none text-foreground">
                        {release.content}
                      </div>
                    </article>
                  );
                })}

                {/* Empty State */}
                {releaseNotes.length === 0 && (
                  <div className="text-center py-16">
                    <p className="text-muted-foreground">No release notes yet. Check back soon!</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </PageContainer>
      </div>
    </div>
  );
};

export default ReleaseNotes;
