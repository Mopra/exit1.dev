import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getBadgeData } from "./badge-api";
import { firestore } from "./init";
import { FieldValue } from "firebase-admin/firestore";

// Public Badge Data API - No authentication required
// CORS enabled for cross-origin embedding
export const badgeData = onRequest({ cors: true }, async (req, res) => {
  // Set CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  
  try {
    // Only allow GET requests
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Get check ID from query parameter
    const checkId = req.query.checkId as string;
    
    if (!checkId || typeof checkId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid checkId parameter' });
      return;
    }

    // Get client IP for rate limiting
    const clientIp = req.headers['x-forwarded-for'] as string || 
                     req.headers['x-real-ip'] as string ||
                     req.ip ||
                     'unknown';

    // Get referer header to track where badges are being used
    const referer = req.headers['referer'] as string || 
                    req.headers['referrer'] as string || 
                    'unknown';

    // Fetch badge data
    const data = await getBadgeData(checkId, clientIp);
    
    if (!data) {
      res.status(404).json({ error: 'Check not found or disabled' });
      return;
    }

    // Track badge usage asynchronously (non-blocking)
    // Don't await - let it run in background
    trackBadgeUsage(checkId, referer, clientIp).catch(err => {
      logger.warn('Failed to track badge usage:', err);
      // Don't throw - tracking failure shouldn't break badge requests
    });

    // Set cache headers (5 minutes)
    res.setHeader('Cache-Control', 'public, max-age=300');
    
    // Return badge data
    res.status(200).json({
      success: true,
      data
    });

  } catch (error) {
    logger.error('Error in badgeData endpoint:', error);
    
    if (error instanceof Error && error.message.includes('Rate limit')) {
      res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      return;
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Track badge usage in Firestore
 * This is called asynchronously and doesn't block the badge response
 */
async function trackBadgeUsage(checkId: string, referer: string, clientIp: string): Promise<void> {
  try {
    const now = Date.now();
    
    // Store badge view in Firestore
    await firestore.collection('badge_views').add({
      checkId,
      referer: referer.length > 500 ? referer.substring(0, 500) : referer, // Limit length
      clientIp: clientIp.length > 50 ? clientIp.substring(0, 50) : clientIp, // Limit length
      timestamp: now,
      createdAt: now,
    });

    // Also update a summary document for quick stats
    // Use checkId as document ID for easy lookup
    const summaryRef = firestore.collection('badge_stats').doc(checkId);
    await summaryRef.set({
      checkId,
      lastViewed: now,
      totalViews: FieldValue.increment(1),
      updatedAt: now,
    }, { merge: true });

    logger.info(`Badge usage tracked for check: ${checkId}`);
  } catch (error) {
    logger.error(`Error tracking badge usage for check ${checkId}:`, error);
    // Don't throw - this is non-critical
  }
}

