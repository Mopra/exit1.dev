import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
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

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

log('Environment check:', {
  NODE_ENV: import.meta.env.NODE_ENV,
  DEV: import.meta.env.DEV,
  MODE: import.meta.env.MODE,
  PUBLISHABLE_KEY_EXISTS: !!PUBLISHABLE_KEY,
  PUBLISHABLE_KEY_LENGTH: PUBLISHABLE_KEY?.length || 0
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
