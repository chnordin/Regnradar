// Vercel Serverless Function (Node.js).
// POST /api/push/subscribe
// Body: { subscription: PushSubscription, lat: number, lng: number }
// Stores the subscription keyed by its endpoint in Upstash Redis.
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Stable hash of an endpoint URL for safe use as a Redis key.
function endpointKey(endpoint) {
  // Base64url encode (no padding) to keep keys short + URL-safe.
  return Buffer.from(endpoint).toString('base64url').slice(0, 96);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { subscription, lat, lng } = req.body || {};
    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys?.p256dh ||
      !subscription.keys?.auth
    ) {
      return res.status(400).json({ error: 'Invalid subscription payload' });
    }
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'lat/lng must be numbers' });
    }

    const record = {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      lat,
      lng,
      createdAt: Date.now(),
      // Used to throttle warnings: only send one push per active rain event.
      lastWarnAt: 0,
    };

    const key = `pushsub:${endpointKey(subscription.endpoint)}`;
    await redis.set(key, JSON.stringify(record));
    // Maintain a set of all subscription keys for the cron sweep.
    await redis.sadd('pushsubs:index', key);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('subscribe error', e);
    return res.status(500).json({ error: 'Internal error', detail: String(e?.message || e) });
  }
}
