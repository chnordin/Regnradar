// Vercel Serverless Function (Node.js).
// POST /api/push/unsubscribe
// Body: { endpoint: string }
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function endpointKey(endpoint) {
  return Buffer.from(endpoint).toString('base64url').slice(0, 96);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    const key = `pushsub:${endpointKey(endpoint)}`;
    await redis.del(key);
    await redis.srem('pushsubs:index', key);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('unsubscribe error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
