import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore } from "firebase-admin/firestore";
import { Website, ApiKeyDoc } from "./types";
import { BigQueryCheckHistoryRow } from './bigquery';

const firestore = getFirestore();
const API_KEYS_COLLECTION = 'apiKeys';

// Helper function to safely parse BigQuery timestamp
function parseBigQueryTimestamp(
  timestamp: unknown,
  entryId: string,
  fallback: number = Date.now()
): number {
  try {
    if (!timestamp) {
      logger.warn(`Missing timestamp for entry ${entryId}, using fallback`);
      return fallback;
    }

    if (typeof timestamp === 'object' && timestamp !== null && 'value' in timestamp) {
      // Expected format: { value: string }
      const value = (timestamp as { value: unknown }).value;
      if (typeof value === 'string' && value) {
        const parsed = new Date(value).getTime();
        if (!isNaN(parsed)) {
          return parsed;
        }
        logger.warn(`Invalid timestamp value for entry ${entryId}: ${value}`);
      }
    } else if (timestamp instanceof Date) {
      // Direct Date object
      return timestamp.getTime();
    } else if (typeof timestamp === 'number') {
      // Already a timestamp number
      if (!isNaN(timestamp) && timestamp > 0) {
        return timestamp;
      }
      logger.warn(`Invalid timestamp number for entry ${entryId}: ${timestamp}`);
    } else if (typeof timestamp === 'string') {
      // String timestamp
      const parsed = new Date(timestamp).getTime();
      if (!isNaN(parsed)) {
        return parsed;
      }
      logger.warn(`Invalid timestamp string for entry ${entryId}: ${timestamp}`);
    } else {
      logger.warn(`Unexpected timestamp format for entry ${entryId}:`, typeof timestamp);
    }
  } catch (e) {
    logger.error(`Error parsing timestamp for entry ${entryId}:`, e);
  }
  return fallback;
}

// Helper functions
async function hashApiKey(key: string): Promise<string> {
  const { createHash } = await import('crypto');
  const pepper = process.env.API_KEY_PEPPER || '';
  return createHash('sha256').update(pepper + key).digest('hex');
}

function parseDateParam(dateStr: string): number {
  // Try parsing as ISO 8601 string first
  const isoDate = new Date(dateStr);
  if (!isNaN(isoDate.getTime())) {
    return isoDate.getTime();
  }
  
  // Try parsing as Unix timestamp (milliseconds)
  const timestamp = Number(dateStr);
  if (!isNaN(timestamp) && timestamp > 0) {
    return timestamp;
  }
  
  // Try parsing as Unix timestamp (seconds) and convert to milliseconds
  const secondsTimestamp = Number(dateStr);
  if (!isNaN(secondsTimestamp) && secondsTimestamp > 0 && secondsTimestamp < 1e12) {
    return secondsTimestamp * 1000;
  }
  
  throw new Error(`Invalid date format: ${dateStr}. Use ISO 8601 (2023-12-21T22:30:56Z) or Unix timestamp`);
}

function sanitizeCheck(doc: { id: string; [key: string]: unknown }) {
  return {
    id: doc.id,
    name: doc.name || doc.url,
    url: doc.url,
    status: doc.status,
    lastChecked: doc.lastChecked,
    responseTime: doc.responseTime ?? null,
    lastStatusCode: doc.lastStatusCode ?? null,
    disabled: !!doc.disabled,
    sslCertificate: doc.sslCertificate || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// Public REST API (X-Api-Key)
export const publicApi = onRequest(async (req, res) => {
  // CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  try {
    const apiKey = (req.header('x-api-key') || req.header('X-Api-Key') || '').trim();
    if (!apiKey) {
      res.status(401).json({ error: 'Missing X-Api-Key' });
      return;
    }

    const hash = await hashApiKey(apiKey);
    const keySnap = await firestore
      .collection(API_KEYS_COLLECTION)
      .where('hash', '==', hash)
      .limit(1)
      .get();

    if (keySnap.empty) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    const keyDoc = keySnap.docs[0];
    const key = keyDoc.data() as ApiKeyDoc;
    if (!key.enabled) {
      res.status(401).json({ error: 'API key disabled' });
      return;
    }

    const userId = key.userId;
    const path = (req.path || req.url || '').replace(/\/+$/, '');
    const segments = path.split('?')[0].split('/').filter(Boolean); // e.g., ['v1','public','checks',':id',...]

    // Track usage (best-effort)
    keyDoc.ref.update({ lastUsedAt: Date.now(), lastUsedPath: path }).catch(() => {});

    // Routing
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // /v1/public/checks
    if (segments.length === 3 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      const limit = Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 100);
      const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
      const statusFilter = String(req.query.status || 'all');

      let q = firestore.collection('checks')
        .where('userId', '==', userId)
        .orderBy('orderIndex', 'asc');

      if (statusFilter !== 'all') {
        q = q.where('status', '==', statusFilter);
      }

      const totalSnap = await q.count().get();
      const total = totalSnap.data().count;

      const snap = await q.limit(limit).offset((page - 1) * limit).get();
      const data = snap.docs.map(d => sanitizeCheck({ id: d.id, ...d.data() }));

      res.json({
        data,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1
        }
      });
      return;
    }

    // /v1/public/checks/:id
    if (segments.length === 4 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks') {
      const checkId = segments[3];
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      res.json({ data: sanitizeCheck({ ...data, id: doc.id }) });
      return;
    }

    // /v1/public/checks/:id/history
    if (segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'history') {
      const checkId = segments[3];
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const limit = Math.min(parseInt(String(req.query.limit || '25'), 10) || 25, 200);
      const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
      const startDate = req.query.from ? parseDateParam(String(req.query.from)) : undefined;
      const endDate = req.query.to ? parseDateParam(String(req.query.to)) : undefined;
      const statusFilter = String(req.query.status || 'all');
      const searchTerm = String(req.query.q || '');

      const { getCheckHistory } = await import('./bigquery.js');

      const history = await getCheckHistory(
        checkId,
        userId,
        limit,
        (page - 1) * limit,
        startDate,
        endDate,
        statusFilter,
        searchTerm
      );

      // total (bounded) — reuse query with high limit 10000
      const totalArr = await getCheckHistory(
        checkId,
        userId,
        10000,
        0,
        startDate,
        endDate,
        statusFilter,
        searchTerm
      );

      // Safely handle history data
      const historyArray = Array.isArray(history) ? history : [];
      if (!Array.isArray(history)) {
        logger.warn(`BigQuery returned non-array history for check ${checkId}, type: ${typeof history}`);
      }

      res.json({
        data: historyArray.map((entry: BigQueryCheckHistoryRow) => {
          const timestampValue = parseBigQueryTimestamp(entry.timestamp, entry.id || 'unknown');
          return {
            id: entry.id || '',
            websiteId: entry.website_id || checkId,
            userId: entry.user_id || userId,
            timestamp: timestampValue,
            status: entry.status || 'unknown',
            responseTime: entry.response_time ?? undefined,
            statusCode: entry.status_code ?? undefined,
            error: entry.error ?? undefined,
            createdAt: timestampValue
          };
        }),
        meta: {
          page,
          limit,
          total: totalArr.length,
          totalPages: Math.ceil(totalArr.length / limit),
          hasNext: page < Math.ceil(totalArr.length / limit),
          hasPrev: page > 1
        }
      });
      return;
    }

    // /v1/public/checks/:id/stats
    if (segments.length === 5 && segments[0] === 'v1' && segments[1] === 'public' && segments[2] === 'checks' && segments[4] === 'stats') {
      const checkId = segments[3];
      const doc = await firestore.collection('checks').doc(checkId).get();
      if (!doc.exists) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const data = doc.data() as Website;
      if (data.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const startDate = req.query.from ? parseDateParam(String(req.query.from)) : undefined;
      const endDate = req.query.to ? parseDateParam(String(req.query.to)) : undefined;

      const { getCheckStats } = await import('./bigquery.js');
      const stats = await getCheckStats(checkId, userId, startDate, endDate);

      res.json({ data: stats });
      return;
    }

    res.status(404).json({ error: 'Not found' });
  } catch (e: unknown) {
    logger.error('publicApi error', e);
    res.status(500).json({ error: 'Internal error' });
  }
});
