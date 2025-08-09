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
import { LoadingScreen, TooltipProvider } from './components/ui';


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
const Profile = lazy(() => import('./pages/Profile'));

const SuccessfulChecks = lazy(() => import('./pages/SuccessfulChecks'));
const LogsBigQuery = lazy(() => import('./pages/LogsBigQuery'));
const SSOCallback = lazy(() => import('./components/auth/SSOCallback'));
const ForgotPassword = lazy(() => import('./components/auth/ForgotPassword'));

export const FirebaseReadyContext = createContext(false);

function App() {
  const { isSignedIn } = useAuth();
  
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
      </TooltipProvider>
    </AuthReadyProvider>
  );
}

export default App;
