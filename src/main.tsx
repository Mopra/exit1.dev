import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { library } from '@fortawesome/fontawesome-svg-core';
import { fas } from '@fortawesome/free-solid-svg-icons';
import { far } from '@fortawesome/free-regular-svg-icons';
import { fab } from '@fortawesome/free-brands-svg-icons';
import App from './App.tsx';
import './style.css';

// Debug logging setup
const DEBUG_MODE = import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true';
const log = (message: string, data?: any) => {
  if (DEBUG_MODE) {
    console.log(`[Main] ${message}`, data || '');
  }
};

log('Starting application initialization');

// Add FontAwesome icons to library
try {
  log('Initializing FontAwesome library');
  library.add(fas, far, fab);
  log('FontAwesome library initialized successfully');
} catch (error) {
  console.error('[Main] FontAwesome initialization error:', error);
}

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
