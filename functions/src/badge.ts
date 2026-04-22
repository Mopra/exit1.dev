// functions/src/badge.ts

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { FixedWindowRateLimiter, applyRateLimitHeaders, getClientIp } from "./rate-limit";
import { renderBadgeSvg, type BadgeType, type BadgeData } from "./badge-svg";
import { trackBadgeView } from "./badge-analytics";
import type { Response } from "express";

const BADGE_RATE_LIMIT_PER_MIN = 60;
const CACHE_MAX_AGE = 300; // 5 minutes
const ERROR_CACHE_MAX_AGE = 60; // 1 minute for error badges
const UPTIME_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const MEM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches CDN s-maxage

/** Tiers that may hide the exit1 branding on badges. Legacy values ('scale', 'premium') kept
 *  so old cached check docs still resolve correctly before the next recompute. */
const PAID_TIERS = new Set(['nano', 'pro', 'agency', 'scale', 'premium']);

const badgeRateLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 20_000 });

// ---------------------------------------------------------------------------
// In-memory caches (per function instance) — eliminates redundant Firestore
// reads and BigQuery queries between CDN cache misses.
// ---------------------------------------------------------------------------
type CacheEntry<T> = { value: T; expiresAt: number };

const checkCache = new Map<string, CacheEntry<FirebaseFirestore.DocumentData | null>>();
const uptimeCache = new Map<string, CacheEntry<number | undefined>>();

function getOrExpire<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  // Cap map size to prevent unbounded memory growth across long-lived instances
  if (map.size >= 2_000) {
    const oldest = map.keys().next().value!;
    map.delete(oldest);
  }
  map.set(key, { value, expiresAt: Date.now() + MEM_CACHE_TTL_MS });
}

function sendSvg(res: Response, svg: string, maxAge: number): void {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', `public, max-age=${maxAge}, s-maxage=${maxAge}`);
  res.status(200).send(svg);
}

const VALID_TYPES = new Set<BadgeType>(['status', 'uptime', 'response']);

export const badge = onRequest({
  cors: true,
  maxInstances: 10,
  memory: '256MiB',
  timeoutSeconds: 30,
}, async (req, res) => {
  // Only GET
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  // Rate limit by IP
  const clientIp = getClientIp(req);
  const decision = badgeRateLimiter.consume(`badge:${clientIp}`, BADGE_RATE_LIMIT_PER_MIN);
  applyRateLimitHeaders(res, decision);
  if (!decision.allowed) {
    res.status(429).send('Rate limit exceeded');
    return;
  }

  // Parse route: /v1/badge/{checkId}
  const segments = (req.path || '').split('/').filter(Boolean);
  if (segments.length < 3 || segments[0] !== 'v1' || segments[1] !== 'badge') {
    sendSvg(res, renderBadgeSvg('status', { name: 'unknown', status: 'unknown' }), ERROR_CACHE_MAX_AGE);
    return;
  }

  const checkId = segments[2];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(checkId)) {
    sendSvg(res, renderBadgeSvg('status', { name: 'unknown', status: 'unknown' }), ERROR_CACHE_MAX_AGE);
    return;
  }
  const type = (VALID_TYPES.has(req.query.type as BadgeType) ? req.query.type : 'status') as BadgeType;
  const wantsBrandingHidden = req.query.branding === 'false' || req.query.branding === '0';

  // Serve JavaScript embed: /v1/badge/{checkId}/embed.js
  if (segments.length >= 4 && segments[3] === 'embed.js') {
    const brandingStr = wantsBrandingHidden ? '&branding=false' : '';
    const badgeUrl = `https://app.exit1.dev/v1/badge/${checkId}?type=${type}${brandingStr}`;
    const js = '(function(){' +
      'var s=document.currentScript;' +
      'var a=document.createElement("a");' +
      'a.href="https://exit1.dev";' +
      'a.target="_blank";' +
      'a.rel="noopener";' +
      'var i=document.createElement("img");' +
      'i.src="' + badgeUrl + '";' +
      'i.alt="exit1 status badge";' +
      'i.style.display="block";' +
      'a.appendChild(i);' +
      's.parentNode.insertBefore(a,s);' +
      '})();';
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`);
    res.status(200).send(js);
    // Track embed.js load — userId not available without a Firestore read, use empty string
    trackBadgeView({
      checkId, userId: '', badgeType: type, embed: true,
      referrer: req.headers.referer || req.headers.referrer as string || null,
      userAgent: req.headers['user-agent'] || null,
      clientIp,
    });
    return;
  }

  try {
    // Read check from Firestore (with in-memory cache)
    let check = getOrExpire(checkCache, checkId);
    if (check === undefined) {
      const checkDoc = await firestore.collection('checks').doc(checkId).get();
      check = checkDoc.exists ? checkDoc.data()! : null;
      setCache(checkCache, checkId, check);
    }
    if (!check) {
      sendSvg(res, renderBadgeSvg('status', { name: 'unknown', status: 'unknown' }), ERROR_CACHE_MAX_AGE);
      return;
    }

    // Determine branding: only paid tiers can hide it
    const branding = wantsBrandingHidden && PAID_TIERS.has(check.userTier) ? false : true;

    const badgeData: BadgeData = {
      name: check.name || check.url || 'unknown',
      status: (check.status as BadgeData['status']) || 'unknown',
      detailedStatus: check.detailedStatus,
      maintenanceMode: check.maintenanceMode || false,
      disabled: check.disabled || false,
      responseTime: check.responseTime,
    };

    // For uptime badge, fetch 30-day uptime from BigQuery daily summaries (with in-memory cache)
    if (type === 'uptime') {
      const cachedUptime = getOrExpire(uptimeCache, checkId);
      if (cachedUptime !== undefined) {
        badgeData.uptimePercentage = cachedUptime;
      } else {
        try {
          const { getUptimeFromDailySummaries } = await import('./bigquery.js');
          const startDate = Date.now() - UPTIME_LOOKBACK_MS;
          const stats = await getUptimeFromDailySummaries([checkId], check.userId, startDate);
          const pct = stats.length > 0 ? stats[0].uptimePercentage : undefined;
          setCache(uptimeCache, checkId, pct);
          badgeData.uptimePercentage = pct;
        } catch (err) {
          logger.warn('Badge: failed to fetch uptime for', checkId, err);
        }
      }
    }

    sendSvg(res, renderBadgeSvg(type, badgeData, branding), CACHE_MAX_AGE);

    // Track badge view (fire-and-forget, never blocks response)
    trackBadgeView({
      checkId, userId: check.userId || '', badgeType: type, embed: false,
      referrer: req.headers.referer || req.headers.referrer as string || null,
      userAgent: req.headers['user-agent'] || null,
      clientIp,
    });
  } catch (err) {
    logger.error('Badge: error serving badge for', checkId, err);
    sendSvg(res, renderBadgeSvg('status', { name: 'unknown', status: 'unknown' }), ERROR_CACHE_MAX_AGE);
  }
});
