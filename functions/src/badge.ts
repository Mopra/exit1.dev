// functions/src/badge.ts

import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { FixedWindowRateLimiter, applyRateLimitHeaders, getClientIp } from "./rate-limit";
import { renderBadgeSvg, type BadgeType, type BadgeData } from "./badge-svg";
import type { Response } from "express";

const BADGE_RATE_LIMIT_PER_MIN = 60;
const CACHE_MAX_AGE = 300; // 5 minutes
const ERROR_CACHE_MAX_AGE = 60; // 1 minute for error badges
const UPTIME_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

const badgeRateLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxKeys: 20_000 });

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

  // Serve JavaScript embed: /v1/badge/{checkId}/embed.js
  if (segments.length >= 4 && segments[3] === 'embed.js') {
    const badgeUrl = `https://app.exit1.dev/v1/badge/${checkId}?type=${type}`;
    const js = '(function(){' +
      'var s=document.currentScript;' +
      'var a=document.createElement("a");' +
      'a.href="https://exit1.dev";' +
      'a.target="_blank";' +
      'a.rel="noopener";' +
      'var i=document.createElement("img");' +
      'i.src="' + badgeUrl + '";' +
      'i.alt="exit1 status badge";' +
      'i.style.height="24px";' +
      'a.appendChild(i);' +
      's.parentNode.insertBefore(a,s);' +
      '})();';
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}`);
    res.status(200).send(js);
    return;
  }

  try {
    // Read check from Firestore
    const checkDoc = await firestore.collection('checks').doc(checkId).get();
    if (!checkDoc.exists) {
      sendSvg(res, renderBadgeSvg('status', { name: 'unknown', status: 'unknown' }), ERROR_CACHE_MAX_AGE);
      return;
    }

    const check = checkDoc.data()!;
    const badgeData: BadgeData = {
      name: check.name || check.url || 'unknown',
      status: (check.status as BadgeData['status']) || 'unknown',
      detailedStatus: check.detailedStatus,
      maintenanceMode: check.maintenanceMode || false,
      disabled: check.disabled || false,
      responseTime: check.responseTime,
    };

    // For uptime badge, fetch 30-day uptime from BigQuery daily summaries
    if (type === 'uptime') {
      try {
        const { getUptimeFromDailySummaries } = await import('./bigquery.js');
        const startDate = Date.now() - UPTIME_LOOKBACK_MS;
        const stats = await getUptimeFromDailySummaries([checkId], check.userId, startDate);
        if (stats.length > 0) {
          badgeData.uptimePercentage = stats[0].uptimePercentage;
        }
      } catch (err) {
        logger.warn('Badge: failed to fetch uptime for', checkId, err);
      }
    }

    sendSvg(res, renderBadgeSvg(type, badgeData), CACHE_MAX_AGE);
  } catch (err) {
    logger.error('Badge: error serving badge for', checkId, err);
    sendSvg(res, renderBadgeSvg('status', { name: 'unknown', status: 'unknown' }), ERROR_CACHE_MAX_AGE);
  }
});
