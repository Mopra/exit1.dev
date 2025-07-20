import { useAuth } from '@clerk/clerk-react';
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

interface AuthGuardProps {
  children: ReactNode;
  fallbackPath?: string;
}

const AuthGuard = ({ children, fallbackPath = '/login' }: AuthGuardProps) => {
  const { isSignedIn, isLoaded } = useAuth();
  const location = useLocation();

  // Show loading while Clerk is initializing
  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="font-mono text-white text-center">
          <div className="text-xl tracking-widest uppercase mb-2">Loading...</div>
          <div className="text-sm opacity-80">→ Checking authentication</div>
        </div>
      </div>
    );
  }

  // Redirect to login if not signed in
  if (!isSignedIn) {
    return <Navigate to={fallbackPath} state={{ from: location }} replace />;
  }

  // Render children if authenticated
  return <>{children}</>;
};

export default AuthGuard; 