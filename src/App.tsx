import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import { useAuth } from '@clerk/clerk-react';
import CustomSignIn from './components/auth/CustomSignIn';
import CustomSignUp from './components/auth/CustomSignUp';
import Layout from './components/layout/Layout';
import AuthGuard from './components/auth/AuthGuard';
import { createContext } from "react";
import { AuthReadyProvider } from './AuthReadyProvider';
import { LoadingScreen } from './components/ui';

// Lazy load components for better performance
const Checks = lazy(() => import('./pages/Checks'));
const Status = lazy(() => import('./pages/Status'));
const Webhooks = lazy(() => import('./pages/Webhooks'));
const Profile = lazy(() => import('./pages/Profile'));
const AiInstructions = lazy(() => import('./pages/AiInstructions'));
const Statistics = lazy(() => import('./pages/Statistics'));
const Incidents = lazy(() => import('./pages/Incidents'));
const SuccessfulChecks = lazy(() => import('./pages/SuccessfulChecks'));
const SSOCallback = lazy(() => import('./components/auth/SSOCallback'));

export const FirebaseReadyContext = createContext(false);

function App() {
  const { isSignedIn } = useAuth();
  return (
    <AuthReadyProvider>
      <Router>
        <Suspense fallback={<Layout><LoadingScreen type="module" /></Layout>}>
          <Routes>
            <Route
              path="/"
              element={
                <Layout>
                  {isSignedIn ? <Navigate to="/checks" replace /> : <CustomSignIn />}
                </Layout>
              }
            />
            <Route
              path="/login"
              element={
                <Layout>
                  {isSignedIn ? <Navigate to="/checks" replace /> : <CustomSignIn />}
                </Layout>
              }
            />
            <Route
              path="/sign-up"
              element={
                <Layout>
                  {isSignedIn ? (
                    <Navigate to="/checks" replace />
                  ) : (
                    <CustomSignUp />
                  )}
                </Layout>
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
              path="/ai-instructions"
              element={
                <Layout>
                  <AiInstructions />
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
              path="/statistics/:checkId"
              element={
                <Layout>
                  <AuthGuard>
                    <Statistics />
                  </AuthGuard>
                </Layout>
              }
            />
            <Route
              path="/incidents/:checkId/:hour/:timestamp"
              element={
                <Layout>
                  <AuthGuard>
                    <Incidents />
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
    </AuthReadyProvider>
  );
}

export default App;
