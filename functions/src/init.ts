import * as logger from "firebase-functions/logger";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createClerkClient } from '@clerk/backend';

// Initialize Firebase Admin
initializeApp({
  credential: applicationDefault(),
});

// Initialize Firestore
export const firestore = getFirestore();
// Avoid failing updates due to undefined fields in partial updates
firestore.settings({ ignoreUndefinedProperties: true });

// Initialize Clerk clients for dual-instance support (dev and prod)
// Environment variables:
// - CLERK_SECRET_KEY: Production instance secret key (backward compatibility)
// - CLERK_SECRET_KEY_PROD: Production instance secret key (explicit)
// - CLERK_SECRET_KEY_DEV: Development instance secret key
// 
// To set these via Firebase CLI:
// firebase functions:config:set clerk.secret_key_prod="your_prod_key"
// firebase functions:config:set clerk.secret_key_dev="your_dev_key"
// Then redeploy functions

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
let clerkClientDev: ReturnType<typeof createClerkClient> | null = null;
let clerkClientProd: ReturnType<typeof createClerkClient> | null = null;

try {
  // Initialize production client
  // Firebase Functions v2 automatically makes secrets available as environment variables
  // Secrets set via 'firebase functions:secrets:set' are accessible via process.env
  const secretKey = process.env.CLERK_SECRET_KEY || process.env.CLERK_SECRET_KEY_PROD;
  
  if (secretKey) {
    clerkClientProd = createClerkClient({
      secretKey: secretKey,
    });
    clerkClient = clerkClientProd; // Default to prod for backward compatibility
    logger.info('Clerk production client initialized successfully');
  }
  
  // Initialize development client
  const devSecretKey = process.env.CLERK_SECRET_KEY_DEV;
  
  if (devSecretKey) {
    clerkClientDev = createClerkClient({
      secretKey: devSecretKey,
    });
    logger.info('Clerk development client initialized successfully');
  }
  
  if (!secretKey && !devSecretKey) {
    logger.warn('No Clerk secret keys found. User management features will be limited.');
    logger.warn('Available env vars:', Object.keys(process.env).filter(key => key.includes('CLERK')));
  }
} catch (error) {
  logger.error('Failed to initialize Clerk clients:', error);
}

// Helper function to get the appropriate Clerk client based on instance type
export function getClerkClient(instance: 'dev' | 'prod'): ReturnType<typeof createClerkClient> | null {
  if (instance === 'dev') {
    return clerkClientDev;
  } else {
    return clerkClientProd || clerkClient; // Fallback to default client
  }
}

// Helper function to get user tier (defaults to free)
export const getUserTier = async (uid: string): Promise<'free' | 'premium'> => {
  try {
    // TODO: Implement actual user tier logic based on subscription status
    // For now, default all users to free tier
    // This could check a users collection, subscription status, etc.
    return 'free';
  } catch (error) {
    logger.warn(`Error getting user tier for ${uid}, defaulting to free:`, error);
    return 'free';
  }
};

