// Vercel Serverless Function (Node.js).
// GET /api/push/check?secret=...
// Called every ~5 minutes by cron-job.org. Iterates all stored subscriptions,
// checks Open-Meteo precipitation for each user's coordinates, and sends a
// Web Push notification if rain >= 0.1 mm/h is predicted within 20 minutes.
import { Redis } from '@upstash/redis';
import webpush from 'web-push';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Configure web-push with VAPID details (set once at cold start).
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:ch.nordin@jejetu.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Min mm/h to consider "rain" (matches the in-app warning threshold).
const RAIN_THRESHOLD_MMH = 0.1;
// Min minutes between two pushes to the same subscription.
const PUSH_COOLDOWN_MIN = 30;

async function checkOneSubscription(rawKey) {
  const json = await redis.get(rawKey);
  if (!json) {
    await redis.srem('pushsubs:index', rawKey);
    return { key: rawKey, status: 'orphan-removed' };
  }
  const sub = typeof json === 'string' ? JSON.parse(json) : json;
  if (!sub?.endpoint || !sub?.keys || !sub?.lat || !sub?.lng) {
    return { key: rawKey, status: 'bad-record' };
  }

  // Throttle: skip if we sent a push within the cooldown window.
  const nowMs = Date.now();
  if (sub.lastWarnAt && nowMs - sub.lastWarnAt < PUSH_COOLDOWN_MIN * 60 * 1000) {
    return { key: rawKey, status: 'cooldown' };
  }

  // Fetch Open-Meteo minutely precipitation for the next 60 minutes.
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${sub.lat}` +
    `&longitude=${sub.lng}&minutely_15=precipitation&forecast_minutely_15=4` +
    `&timezone=UTC`;
  let data;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return { key: rawKey, status: `om-${r.status}` };
    data = await r.json();
  } catch (e) {
    return { key: rawKey, status: 'om-fetch-fail', error: String(e?.message || e) };
  }

  const times = data?.minutely_15?.time || [];
  const precip = data?.minutely_15?.precipitation || [];
  // Open-Meteo returns mm per 15-min slot. Convert to mm/h for comparison.
  // Look at the slots covering the next ~20 minutes from now.
  const now = Date.now();
  let earliestRainMin = null;
  let mmhAtRain = 0;
  for (let i = 0; i < times.length; i++) {
    const slotMs = new Date(times[i] + 'Z').getTime();
    const dtMin = (slotMs - now) / 60000;
    if (dtMin < -2) continue; // slot already past
    if (dtMin > 20) break;    // beyond 20-min horizon
    const mm = Number(precip[i] || 0);
    const mmh = mm * 4; // 15 min slot -> per hour
    if (mmh >= RAIN_THRESHOLD_MMH) {
      earliestRainMin = Math.max(1, Math.round(dtMin));
      mmhAtRain = mmh;
      break;
    }
  }

  if (earliestRainMin == null) {
    return { key: rawKey, status: 'no-rain' };
  }

  // Compose and send push.
  const payload = JSON.stringify({
    title: 'Regnradar',
    body: 'Regn förväntas inom 20 minuter',
    minutes: earliestRainMin,
    mmh: Number(mmhAtRain.toFixed(2)),
  });

  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { TTL: 60 * 25 } // 25 min — slightly longer than the warning horizon
    );
    // Update lastWarnAt to enforce cooldown.
    sub.lastWarnAt = nowMs;
    await redis.set(rawKey, JSON.stringify(sub));
    return { key: rawKey, status: 'sent', minutes: earliestRainMin };
  } catch (e) {
    // If the subscription is gone (410) or invalid (404), clean it up.
    const code = e?.statusCode;
    if (code === 404 || code === 410) {
      await redis.del(rawKey);
      await redis.srem('pushsubs:index', rawKey);
      return { key: rawKey, status: `removed-${code}` };
    }
    return { key: rawKey, status: 'send-fail', code, error: String(e?.message || e) };
  }
}

export default async function handler(req, res) {
  // Secret guard: cron must pass ?secret= matching env.
  if (process.env.CRON_SECRET && req.query?.secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: 'VAPID keys not configured' });
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: 'Upstash Redis not configured' });
  }

  try {
    const keys = (await redis.smembers('pushsubs:index')) || [];
    if (!keys.length) {
      return res.status(200).json({ ok: true, subscriptions: 0, results: [] });
    }

    // Run all checks in parallel — each is one fetch + maybe one push.
    const results = await Promise.all(keys.map((k) => checkOneSubscription(k).catch((e) => ({ key: k, status: 'crash', error: String(e?.message || e) }))));

    const summary = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    return res.status(200).json({
      ok: true,
      subscriptions: keys.length,
      summary,
      results,
    });
  } catch (e) {
    console.error('check error', e);
    return res.status(500).json({ error: 'Internal error', detail: String(e?.message || e) });
  }
}
