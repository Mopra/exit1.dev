import { onCall } from "firebase-functions/v2/https";
import { firestore } from "./init";

const API_KEYS_COLLECTION = 'apiKeys';

type ApiKeyDoc = {
  userId: string;
  name?: string;
  hash: string;
  prefix: string;
  last4: string;
  enabled: boolean;
  scopes?: string[];
  createdAt: number;
  lastUsedAt?: number;
  lastUsedPath?: string;
};

async function generateApiKey(): Promise<string> {
  const { randomBytes } = await import('crypto');
  // ek_live_ + 32 bytes hex (64 chars)
  return `ek_live_${randomBytes(32).toString('hex')}`;
}

async function hashApiKey(key: string): Promise<string> {
  const { createHash } = await import('crypto');
  const pepper = process.env.API_KEY_PEPPER || '';
  return createHash('sha256').update(pepper + key).digest('hex');
}

function extractPrefix(key: string): string {
  return key.slice(0, 12);
}

function last4(key: string): string {
  return key.slice(-4);
}



// Create API key (returns plaintext once)
export const createApiKey = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  const { name = '' , scopes = [] } = request.data || {};
  const key = await generateApiKey();
  const hash = await hashApiKey(key);
  const now = Date.now();

  const docRef = await firestore.collection(API_KEYS_COLLECTION).add({
    userId: uid,
    name: String(name).slice(0, 100),
    hash,
    prefix: extractPrefix(key),
    last4: last4(key),
    enabled: true,
    scopes: Array.isArray(scopes) ? scopes : [],
    createdAt: now,
  } as ApiKeyDoc);

  return {
    id: docRef.id,
    key, // show once
    name,
    prefix: extractPrefix(key),
    last4: last4(key),
    createdAt: now,
  };
});

// List API keys (sanitized)
export const listApiKeys = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");

  const snap = await firestore
    .collection(API_KEYS_COLLECTION)
    .where('userId', '==', uid)
    .get();

  const keys = snap.docs.map((d) => {
    const data = d.data() as ApiKeyDoc;
    return {
      id: d.id,
      name: data.name || '',
      prefix: data.prefix,
      last4: data.last4,
      enabled: data.enabled,
      createdAt: data.createdAt,
      lastUsedAt: data.lastUsedAt || null,
      scopes: data.scopes || [],
    };
  });

  // Sort by createdAt descending (newest first)
  keys.sort((a, b) => b.createdAt - a.createdAt);

  return { success: true, data: keys };
});

// Revoke API key
export const revokeApiKey = onCall({
  cors: true,
  maxInstances: 10,
}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new Error("Authentication required");
  const { id } = request.data || {};
  if (!id) throw new Error("Key ID required");

  const ref = firestore.collection(API_KEYS_COLLECTION).doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Key not found");
  const data = doc.data() as ApiKeyDoc;
  if (data.userId !== uid) throw new Error("Insufficient permissions");

  await ref.update({ enabled: false, lastUsedAt: Date.now() });
  return { success: true };
});

