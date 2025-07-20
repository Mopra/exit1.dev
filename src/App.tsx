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
const Websites = lazy(() => import('./pages/Websites'));
const Status = lazy(() => import('./pages/Status'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Profile = lazy(() => import('./pages/Profile'));
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
                  {isSignedIn ? <Navigate to="/websites" replace /> : <CustomSignIn />}
                </Layout>
              }
                        />
            <Route
              path="/login"
              element={
                <Layout>
                  {isSignedIn ? <Navigate to="/websites" replace /> : <CustomSignIn />}
                </Layout>
              }
            />
            <Route
              path="/sign-up"
              element={
                <Layout>
                  {isSignedIn ? (
                    <Navigate to="/websites" replace />
                  ) : (
                    <CustomSignUp />
                  )}
                </Layout>
              }
            />
            <Route
              path="/websites"
              element={
                <Layout>
                  <AuthGuard>
                    <Websites />
                  </AuthGuard>
                </Layout>
              }
            />
            <Route
              path="/notifications"
              element={
                <Layout>
                  <AuthGuard>
                    <Notifications />
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
              element={<Status />}
            />
            <Route
              path="*"
              element={
                <Layout>
                  {isSignedIn ? <Navigate to="/websites" replace /> : <CustomSignIn />}
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
