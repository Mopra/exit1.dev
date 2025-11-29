import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { useAuth } from '@clerk/clerk-react';
import CustomSignIn from './components/auth/CustomSignIn';
import CustomSignUp from './components/auth/CustomSignUp';
import Layout from './components/layout/Layout';
import AuthGuard from './components/auth/AuthGuard';
import { createContext } from "react";
import { AuthReadyProvider } from './AuthReadyProvider';
import { LoadingScreen, TooltipProvider, Toaster } from './components/ui';

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
const Status = lazy(() => import('./pages/Status'));
const Webhooks = lazy(() => import('./pages/Webhooks'));
const Emails = lazy(() => import('./pages/Emails'));
const Profile = lazy(() => import('./pages/Profile'));
const Badge = lazy(() => import('./pages/Badge'));

const SuccessfulChecks = lazy(() => import('./pages/SuccessfulChecks'));
const LogsBigQuery = lazy(() => import('./pages/LogsBigQuery'));
const Reports = lazy(() => import('./pages/Reports'));
const API = lazy(() => import('./pages/Settings'));
const UserAdmin = lazy(() => import('./pages/UserAdmin'));
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'));
const BulkEmail = lazy(() => import('./pages/BulkEmail'));
const SSOCallback = lazy(() => import('./components/auth/SSOCallback'));
const ForgotPassword = lazy(() => import('./components/auth/ForgotPassword'));
const PublicStatus = lazy(() => import('./pages/PublicStatus'));
const OptOut = lazy(() => import('./pages/OptOut'));

export const FirebaseReadyContext = createContext(false);

function App() {
  const { isSignedIn } = useAuth();
  
  // Handle website URL parameter at app level
  React.useEffect(() => {
    console.log('App: useEffect running, current URL:', window.location.href);
    const urlParams = new URLSearchParams(window.location.search);
    const websiteParam = urlParams.get('website');
    console.log('App: Website parameter found:', websiteParam);
    
    if (websiteParam) {
      try {
        const decodedUrl = decodeURIComponent(websiteParam);
        console.log('App: Processing website URL parameter:', decodedUrl);
        
        // Validate the URL
        let urlToValidate = decodedUrl;
        if (!urlToValidate.startsWith('http://') && !urlToValidate.startsWith('https://')) {
          urlToValidate = `https://${urlToValidate}`;
        }
        
        new URL(urlToValidate); // This will throw if invalid
        
        // Store in localStorage for after authentication
        localStorage.setItem(WEBSITE_URL_STORAGE_KEY, decodedUrl);
        console.log('App: Stored website URL in localStorage:', decodedUrl);
        
        // Verify storage
        const stored = localStorage.getItem(WEBSITE_URL_STORAGE_KEY);
        console.log('App: Verified stored value:', stored);
        
        // Clean up the URL parameter
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('website');
        window.history.replaceState({}, '', newUrl.toString());
        console.log('App: URL parameter cleaned up');
        
      } catch (error) {
        console.error('App: Invalid website URL parameter:', websiteParam, error);
      }
    } else {
      console.log('App: No website parameter found in URL');
    }
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
      <TooltipProvider>
        <Router>
          <Suspense fallback={
            <Layout>
              <LoadingScreen type="module" />
            </Layout>
          }>
            <Routes>
              <Route
                path="/"
                element={
                  isSignedIn ? (
                    <Layout>
                      <Navigate to="/checks" replace />
                    </Layout>
                  ) : (
                    <CustomSignIn />
                  )
                }
              />
              <Route
                path="/login"
                element={
                  isSignedIn ? (
                    <Layout>
                      <Navigate to="/checks" replace />
                    </Layout>
                  ) : (
                    <CustomSignIn />
                  )
                }
              />
              <Route
                path="/sign-up"
                element={
                  isSignedIn ? (
                    <Layout>
                      <Navigate to="/checks" replace />
                    </Layout>
                  ) : (
                    <CustomSignUp />
                  )
                }
              />
              <Route
                path="/forgot-password"
                element={
                  isSignedIn ? (
                    <Layout>
                      <Navigate to="/checks" replace />
                    </Layout>
                  ) : (
                    <ForgotPassword />
                  )
                }
              />
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
                path="/badge"
                element={
                  <Layout>
                    <AuthGuard>
                      <Badge />
                    </AuthGuard>
                  </Layout>
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
                path="/admin-email"
                element={
                  <Layout>
                    <AuthGuard>
                      <BulkEmail />
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
                path="/opt-out"
                element={<OptOut />}
              />
              <Route
                path="*"
                element={
                  <Layout>
                    {isSignedIn ? <Navigate to="/checks" replace /> : <Navigate to="/" replace />}
                  </Layout>
                }
              />
            </Routes>
          </Suspense>
        </Router>
        <Toaster />
      </TooltipProvider>
    </AuthReadyProvider>
  );
}

export default App;
