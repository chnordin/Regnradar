// Vercel Serverless Function (Node.js).
// GET /api/push/vapid-public-key
// Returns the VAPID public key so the frontend can subscribe to PushManager.
export default function handler(req, res) {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(500).json({ error: 'VAPID_PUBLIC_KEY not configured' });
  }
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).json({ publicKey: key });
}
