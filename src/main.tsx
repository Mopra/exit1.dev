import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import { library } from '@fortawesome/fontawesome-svg-core';
import { fas } from '@fortawesome/free-solid-svg-icons';
import { far } from '@fortawesome/free-regular-svg-icons';
import { fab } from '@fortawesome/free-brands-svg-icons';
import App from './App.tsx';
import './style.css';

// Add FontAwesome icons to library
library.add(fas, far, fab);

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing Publishable Key");
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider 
      publishableKey={PUBLISHABLE_KEY} 
      afterSignOutUrl="/"
    >
      <App />
    </ClerkProvider>
  </StrictMode>,
);
