import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { dark } from '@clerk/themes';
import App from './App.tsx';
import './style.css';

// Enable system theme preference for shadcn/ui
// Dark mode will be handled by a theme provider component

// Debug logging setup
const DEBUG_MODE = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true';
const log = (message: string, data?: any) => {
  if (DEBUG_MODE) {
    console.log(`[Main] ${message}`, data || '');
  }
};

log('Starting application initialization');

// FontAwesome library initialization removed - using Lucide React icons instead

// Dual-instance Clerk setup:
// - Production instance: Used for all new users
// - Development instance: Used for existing users during gradual migration
// The migration table (userMigrations) tracks which instance each user belongs to

// Determine if we're running on localhost
const isLocalhost = window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' ||
                    window.location.hostname === '';

// Use dev key for localhost, prod key for production
// You can set VITE_CLERK_PUBLISHABLE_KEY_DEV in your .env.local file for localhost development
const PUBLISHABLE_KEY = isLocalhost 
  ? (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY_DEV || import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)
  : import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

log('Environment check:', {
  NODE_ENV: import.meta.env.NODE_ENV,
  DEV: import.meta.env.DEV,
  MODE: import.meta.env.MODE,
  HOSTNAME: window.location.hostname,
  IS_LOCALHOST: isLocalhost,
  PUBLISHABLE_KEY_EXISTS: !!PUBLISHABLE_KEY,
  PUBLISHABLE_KEY_LENGTH: PUBLISHABLE_KEY?.length || 0,
  USING_DEV_KEY: isLocalhost && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY_DEV
});

if (!PUBLISHABLE_KEY) {
  console.error('[Main] Missing Publishable Key - this will cause the app to fail');
  throw new Error("Missing Publishable Key");
}

log('Publishable key validation passed');

// Check for root element
const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('[Main] Root element not found - this will cause the app to fail');
  throw new Error("Root element not found");
}

log('Root element found, creating React root');

try {
  const root = createRoot(rootElement);
  log('React root created successfully');
  
  log('Rendering application with StrictMode and ClerkProvider');
  root.render(
    <StrictMode>
      <ClerkProvider 
        publishableKey={PUBLISHABLE_KEY} 
        afterSignOutUrl="/"
        appearance={{ theme: dark }}
      >
        <App />
      </ClerkProvider>
    </StrictMode>,
  );
  log('Application rendered successfully');
} catch (error) {
  console.error('[Main] Critical error during app initialization:', error);
  throw error;
}
