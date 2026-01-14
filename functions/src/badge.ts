import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getBadgeData } from "./badge-api";
import { URL } from "url";
import { parse as parseTld } from "tldts";
import { queueBadgeUsageEvent } from "./badge-buffer";
import { CONFIG } from "./config";

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
    if (!CONFIG.ENABLE_BADGES) {
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.status(410).json({ error: 'Embeddable badges are disabled.' });
      return;
    }

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

    const domain = extractDomainFromReferer(referer);
    const trimmedReferer = referer.length > 500 ? referer.substring(0, 500) : referer;
    const trimmedClientIp = clientIp.length > 50 ? clientIp.substring(0, 50) : clientIp;
    const viewedAt = Date.now();

    // Track badge usage asynchronously with buffering safeguards.
    queueBadgeUsageEvent({
      checkId,
      referer: trimmedReferer,
      domain,
      clientIp: trimmedClientIp,
      timestamp: viewedAt,
    }).catch(err => {
      logger.error("Failed to enqueue badge usage event", err);
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
 * Extract domain from referer URL (the domain where badge is displayed)
 */
function extractDomainFromReferer(referer: string): string | null {
  if (!referer || referer === 'unknown') {
    return null;
  }

  try {
    const url = new URL(referer);
    const hostname = url.hostname;
    
    // Skip localhost and internal domains
    if (hostname.includes('localhost') || hostname.includes('127.0.0.1') || hostname.includes('::1')) {
      return null;
    }

    // Use tldts to get the registrable domain (e.g., example.com from subdomain.example.com)
    const parsed = parseTld(hostname, { validateHostname: true });
    return parsed.domain || hostname;
  } catch (error) {
    logger.warn(`Failed to extract domain from referer: ${referer}`, error);
    return null;
  }
}

