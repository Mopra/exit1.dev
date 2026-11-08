import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { Globe } from 'lucide-react';
import { db } from './firebase';
import { Spinner, Toaster, TooltipProvider } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { devCustomHostPageId } from './lib/app-hosts';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import type { StatusPage } from './types';

const PublicStatus = lazy(() => import('./pages/PublicStatus'));

const APP_ORIGIN = 'https://app.exit1.dev';

type Resolution =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'disabled'; statusPageId: string }
  | { state: 'ready'; statusPageId: string };

/**
 * Entry for a customer's custom status page domain (status.acme.com), served
 * through the status-domain-proxy Worker. Rendered by main.tsx instead of the
 * app, so Clerk, Clarity and the app shell never load here. Resolves the
 * hostname to its public status page and renders PublicStatus with an
 * anonymous viewer.
 */
export default function CustomDomainApp({ host }: { host: string }) {
  const [resolution, setResolution] = useState<Resolution>({ state: 'loading' });

  // A custom domain only ever shows its status page, at `/`.
  useEffect(() => {
    if (window.location.pathname !== '/') {
      // Dev keeps the query so ?customHost= survives the rewrite.
      const search = import.meta.env.DEV ? window.location.search : '';
      window.history.replaceState(null, '', '/' + search);
    }
  }, []);

  useEffect(() => {
    const devPageId = devCustomHostPageId();
    if (devPageId) {
      setResolution({ state: 'ready', statusPageId: devPageId });
      return;
    }
    let cancelled = false;
    // One read per page view. The visibility filter is what lets an
    // anonymous visitor run this query under the status_pages read rule.
    const q = query(
      collection(db, 'status_pages'),
      where('customDomain.hostname', '==', host),
      where('visibility', '==', 'public'),
      limit(1),
    );
    getDocs(q)
      .then((snap) => {
        if (cancelled) return;
        const hit = snap.docs[0];
        if (!hit) {
          setResolution({ state: 'missing' });
          return;
        }
        const page = hit.data() as Partial<StatusPage>;
        setResolution(page.customDomain?.status === 'disabled'
          ? { state: 'disabled', statusPageId: hit.id }
          : { state: 'ready', statusPageId: hit.id });
      })
      .catch((error) => {
        console.error('[CustomDomainApp] Failed to resolve status page for host', host, error);
        if (!cancelled) setResolution({ state: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [host]);

  return (
    <TooltipProvider>
      <BrowserRouter>
        <ErrorBoundary>
          {resolution.state === 'loading' && <CenteredSpinner />}
          {resolution.state === 'missing' && (
            <Notice title="No status page is configured for this address" />
          )}
          {resolution.state === 'disabled' && (
            <Notice
              title="This status page is not available on this address"
              link={{ href: `${APP_ORIGIN}/status/${resolution.statusPageId}`, label: 'Open the status page' }}
            />
          )}
          {resolution.state === 'ready' && (
            <CustomDomainSuspense>
              <PublicStatus statusPageId={resolution.statusPageId} />
            </CustomDomainSuspense>
          )}
        </ErrorBoundary>
      </BrowserRouter>
      <Toaster />
    </TooltipProvider>
  );
}

function CustomDomainSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<CenteredSpinner />}>{children}</Suspense>;
}

function CenteredSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Spinner size="lg" className="text-muted-foreground" />
    </div>
  );
}

function Notice({ title, link }: { title: string; link?: { href: string; label: string } }) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <main className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border bg-card p-8 text-center">
          <Globe className="mx-auto mb-4 size-8 text-muted-foreground" aria-hidden />
          <h1 className="text-lg font-semibold">{title}</h1>
          {link && (
            <a
              href={link.href}
              className="mt-4 inline-block text-sm text-primary underline-offset-4 hover:underline"
            >
              {link.label}
            </a>
          )}
        </div>
      </main>
      <footer className="pb-6 text-center text-xs text-muted-foreground">
        <a href="https://exit1.dev" target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
          exit1.dev
        </a>
      </footer>
    </div>
  );
}
