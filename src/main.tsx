import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ClerkProvider } from '@clerk/clerk-react'

const clerkPubKey = 'pk_test_YWR2YW5jZWQtZmlyZWZseS0xOS5jbGVyay5hY2NvdW50cy5kZXYk'

createRoot(document.getElementById('root')!).render(
  <ClerkProvider publishableKey={clerkPubKey} afterSignOutUrl="/">
    <StrictMode>
      <App />
    </StrictMode>
  </ClerkProvider>,
)
