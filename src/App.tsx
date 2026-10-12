import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Suspense } from 'react';
import { lazyWithRetry as lazy } from './utils/lazyWithRetry';
import { useAuth, useUser } from '@clerk/clerk-react';
import CustomSignIn from './components/auth/CustomSignIn';
import CustomSignUp from './components/auth/CustomSignUp';
import Layout from './components/layout/Layout';
import AuthGuard from './components/auth/AuthGuard';
import { createContext } from "react";
import { AccountProvider } from './AccountProvider';
import { AuthReadyProvider } from './AuthReadyProvider';
import { LoadingScreen, TooltipProvider, Toaster } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useOnboardingStatus } from './hooks/useOnboardingStatus';
import { PendingFollow, PENDING_FOLLOW_STORAGE_KEY } from './components/follow/PendingFollow';

// Website URL storage key
const WEBSITE_URL_STORAGE_KEY = 'exit1_website_url';


// Debug logging setup
const DEBUG_MODE = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true';
const log = (message: string, data?: any) => {
  if (DEBUG_MODE) {
    console.log(`[App] ${message}`, data || '');
  }
};

// Lazy load components for better performance
const Checks = lazy(() => import('./pages/Checks'));
const LiveCheck = lazy(() => import('./pages/LiveCheck'));
const LiveCheckRedirect = lazy(() => import('./pages/LiveCheckRedirect'));
const Status = lazy(() => import('./pages/Status'));
const Webhooks = lazy(() => import('./pages/Webhooks'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Emails = lazy(() => import('./pages/Emails'));
const Sms = lazy(() => import('./pages/Sms'));
const Profile = lazy(() => import('./pages/Profile'));
const Team = lazy(() => import('./pages/Team'));
const SuccessfulChecks = lazy(() => import('./pages/SuccessfulChecks'));
const LogsBigQuery = lazy(() => import('./pages/LogsBigQuery'));
const Reports = lazy(() => import('./pages/Reports'));
const API = lazy(() => import('./pages/Api'));
const ApiKeys = lazy(() => import('./pages/ApiKeys'));
const Mcp = lazy(() => import('./pages/Mcp'));
const Following = lazy(() => import('./pages/Following'));
const UserAdmin = lazy(() => import('./pages/UserAdmin'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const SystemNotifications = lazy(() => import('./pages/SystemNotifications'));
const BadgeAnalytics = lazy(() => import('./pages/BadgeAnalytics'));
const AdminOnboarding = lazy(() => import('./pages/AdminOnboarding'));
const AdminShadowStats = lazy(() => import('./pages/AdminShadowStats'));
const Billing = lazy(() => import('./pages/Billing'));
const SSOCallback = lazy(() => import('./components/auth/SSOCallback'));
const ForgotPassword = lazy(() => import('./components/auth/ForgotPassword'));
const PublicStatus = lazy(() => import('./pages/PublicStatus'));
const ReleaseNotes = lazy(() => import('./pages/ReleaseNotes'));
const DomainIntelligence = lazy(() => import('./pages/DomainIntelligence'));
const Privacy = lazy(() => import('./pages/Privacy'));
const Terms = lazy(() => import('./pages/Terms'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Authorize = lazy(() => import('./pages/Authorize'));
const Claim = lazy(() => import('./pages/Claim'));

export const FirebaseReadyContext = createContext(false);

// Wrapper components for auth routes to prevent React hooks mismatch (error #310).
// When isSignedIn flips from undefined→true (existing session cookie), rendering
// different component trees inline in a <Route element={}> causes a hook count change.
// These wrappers keep a stable component boundary so React unmounts/remounts cleanly.
function GuestRoute({ children, redirectTo }: { children: React.ReactNode; redirectTo?: string }) {
  const { isSignedIn, isLoaded } = useAuth();
  const { hydrated, completed } = useOnboardingStatus();
  if (!isLoaded) return null;
  if (isSignedIn) {
    if (!redirectTo && !hydrated) return null;
    const dest = redirectTo || (completed ? '/checks' : '/onboarding');
    return <Layout><Navigate to={dest} replace /></Layout>;
  }
  return <>{children}</>;
}

// An account an AI agent created stays "unclaimed" until its owner decides
// whether the agent keeps access. Every post-auth path funnels through
// /onboarding, so gating it here catches an owner who signs in normally
// instead of through the claim email.
function UnclaimedAgentGate({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser();
  if (!isLoaded) return null;
  const agentSignup = user?.publicMetadata?.agentSignup as { status?: string } | undefined;
  if (agentSignup?.status === 'unclaimed') return <Navigate to="/claim" replace />;
  return <>{children}</>;
}

function App() {
  const { isSignedIn } = useAuth();
  const onboardingStatus = useOnboardingStatus();
  // Handle website URL parameter at app level
  React.useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const websiteParam = urlParams.get('website');

    if (websiteParam) {
      try {
        const decodedUrl = decodeURIComponent(websiteParam);

        // Validate the URL - only allow http/https protocols
        let urlToValidate = decodedUrl;
        if (!urlToValidate.startsWith('http://') && !urlToValidate.startsWith('https://')) {
          urlToValidate = `https://${urlToValidate}`;
        }

        const urlObj = new URL(urlToValidate); // This will throw if invalid
        // Only allow http and https protocols to prevent javascript: and data: schemes
        if (!['http:', 'https:'].includes(urlObj.protocol)) {
          throw new Error('Only HTTP and HTTPS URLs are allowed');
        }

        // Store in localStorage for after authentication
        localStorage.setItem(WEBSITE_URL_STORAGE_KEY, decodedUrl);

        // Clean up the URL parameter
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('website');
        window.history.replaceState({}, '', newUrl.toString());

      } catch (error) {
        console.error('App: Invalid website URL parameter:', websiteParam, error);
      }
    }
  }, []);

  // ?follow=<slug> comes from "Alert me" on the marketing site's /status pages.
  // Stash it so PendingFollow applies it once the user is signed in, which for
  // a new visitor is after sign-up.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    const follow = url.searchParams.get('follow');
    if (!follow) return;
    if (/^[a-z0-9.-]{1,200}$/i.test(follow)) localStorage.setItem(PENDING_FOLLOW_STORAGE_KEY, follow.toLowerCase());
    url.searchParams.delete('follow');
    window.history.replaceState({}, '', url.toString());
  }, []);

  // Only log once on mount, not on every render
  React.useEffect(() => {
    log('App component mounted', {
      isSignedIn,
      timestamp: new Date().toISOString()
    });
  }, []);

  return (
    <AuthReadyProvider>
      <AccountProvider>
      <TooltipProvider>
        <Router>
          <PendingFollow />
          <ErrorBoundary>
          <Suspense fallback={
            <Layout>
              <LoadingScreen type="module" />
            </Layout>
          }>
            <Routes>
              <Route path="/" element={<GuestRoute><CustomSignIn /></GuestRoute>} />
              <Route path="/login" element={<GuestRoute><CustomSignIn /></GuestRoute>} />
              <Route path="/sign-up" element={<GuestRoute><CustomSignUp /></GuestRoute>} />
              <Route path="/forgot-password" element={<GuestRoute redirectTo="/checks"><ForgotPassword /></GuestRoute>} />
              <Route
                path="/checks"
                element={
                  <Layout>
                    <AuthGuard>
                      <Checks />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/check"
                element={
                  <Layout>
                    <AuthGuard>
                      <LiveCheckRedirect />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/checks/:checkId"
                element={
                  <Layout>
                    <AuthGuard>
                      <LiveCheck />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/webhooks"
                element={
                  <Layout>
                    <AuthGuard>
                      <Webhooks />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/integrations"
                element={
                  <Layout>
                    <AuthGuard>
                      <Integrations />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/emails"
                element={
                  <Layout>
                    <AuthGuard>
                      <Emails />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/sms"
                element={
                  <Layout>
                    <AuthGuard>
                      <Sms />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/logs"
                element={
                  <Layout>
                    <AuthGuard>
                      <LogsBigQuery />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/reports"
                element={
                  <Layout>
                    <AuthGuard>
                      <Reports />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/api"
                element={
                  <Layout>
                    <AuthGuard>
                      <API />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/api-keys"
                element={
                  <Layout>
                    <AuthGuard>
                      <ApiKeys />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/following"
                element={
                  <Layout>
                    <AuthGuard>
                      <Following />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/mcp"
                element={
                  <Layout>
                    <AuthGuard>
                      <Mcp />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/team"
                element={
                  <Layout>
                    <AuthGuard>
                      <Team />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/billing"
                element={
                  <Layout>
                    <AuthGuard>
                      <Billing />
                    </AuthGuard>
                  </Layout>
                }
              />
              {/* Founders is closed to new signups — the upgrade surface was
                  removed. Existing Founders subscribers keep their plan and
                  still see the Founders card + badge on /billing. Old links
                  and bookmarks redirect rather than 404. */}
              <Route
                path="/founders-upgrade"
                element={<Navigate to="/billing" replace />}
              />
              <Route
                path="/onboarding"
                element={
                  <AuthGuard>
                    <UnclaimedAgentGate>
                      <Onboarding />
                    </UnclaimedAgentGate>
                  </AuthGuard>
                }
              />
              {/* OAuth consent for MCP clients. Standalone (no Layout) — the
                  visitor arrives from an external AI tool mid-flow and is sent
                  straight back out again. AuthGuard here is what turns an
                  unauthenticated agent connection into a Clerk sign-up. */}
              {/* Claim page for agent-created accounts. Deliberately outside
                  AuthGuard: the owner arrives signed out, carrying a sign-in
                  ticket from the claim email that the page itself redeems. */}
              <Route path="/claim" element={<Claim />} />
              <Route
                path="/authorize/:requestId"
                element={
                  <AuthGuard>
                    <Authorize />
                  </AuthGuard>
                }
              />
              <Route
                path="/profile"
                element={
                  <Layout>
                    <AuthGuard>
                      <Profile />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/user-admin"
                element={
                  <Layout>
                    <AuthGuard>
                      <UserAdmin />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/admin"
                element={
                  <Layout>
                    <AuthGuard>
                      <AdminDashboard />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/admin/notifications"
                element={
                  <Layout>
                    <AuthGuard>
                      <SystemNotifications />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/admin/badges"
                element={
                  <Layout>
                    <AuthGuard>
                      <BadgeAnalytics />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/admin/onboarding"
                element={
                  <Layout>
                    <AuthGuard>
                      <AdminOnboarding />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/admin/shadow-stats"
                element={
                  <Layout>
                    <AuthGuard>
                      <AdminShadowStats />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/domain-intelligence"
                element={
                  <Layout>
                    <AuthGuard>
                      <DomainIntelligence />
                    </AuthGuard>
                  </Layout>
                }
              />

              <Route
                path="/sso-callback"
                element={<SSOCallback />}
              />
              <Route
                path="/status"
                element={
                  <Layout>
                    <AuthGuard>
                      <Status />
                    </AuthGuard>
                  </Layout>
                }
              />

              <Route
                path="/successful-checks/:checkId/:hour/:timestamp"
                element={
                  <Layout>
                    <AuthGuard>
                      <SuccessfulChecks />
                    </AuthGuard>
                  </Layout>
                }
              />
              <Route
                path="/status/:checkId"
                element={<PublicStatus />}
              />
              <Route
                path="/release-notes"
                element={<ReleaseNotes />}
              />
              <Route
                path="/privacy"
                element={<Privacy />}
              />
              <Route
                path="/terms"
                element={<Terms />}
              />
              <Route
                path="*"
                element={
                  <Layout>
                    {isSignedIn
                      ? onboardingStatus.hydrated
                        ? <Navigate to={onboardingStatus.completed ? '/checks' : '/onboarding'} replace />
                        : null
                      : <Navigate to="/" replace />}
                  </Layout>
                }
              />
            </Routes>
          </Suspense>
          </ErrorBoundary>
        </Router>
        <Toaster />
      </TooltipProvider>
      </AccountProvider>
    </AuthReadyProvider>
  );
}

export default App;
