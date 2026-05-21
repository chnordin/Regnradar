# Regnradar — Push Notifications Setup

Step-by-step guide to enable VAPID Web Push (rain warnings via iPhone Safari 16.4+ PWA).

## 1. Skapa Upstash Redis (gratis, ~1 minut)

1. Gå till https://upstash.com → "Sign Up"
2. Skapa en ny **Redis**-databas:
   - Name: `regnradar`
   - Region: Välj närmast Sverige (e.g. `eu-west-1` Ireland)
   - Type: **Regional** (Free tier)
3. På databasens sida, scrolla ner till **REST API**:
   - Kopiera `UPSTASH_REDIS_REST_URL`
   - Kopiera `UPSTASH_REDIS_REST_TOKEN`

## 2. Lägg till miljövariabler på Vercel

Gå till ditt projekt på Vercel → **Settings** → **Environment Variables**.

Lägg till följande (för **Production**, **Preview** och **Development**):

| Namn | Värde |
|---|---|
| `VAPID_PUBLIC_KEY` | `BJbPusiy3_7pTmvLCtQpXqHt0kSj-aKRUafVug4iMhHyLuZg_uUsfHM4sgQzXq2NexGpa5oRnotXvxUpoI5qhD0` |
| `VAPID_PRIVATE_KEY` | `81u557H3si6PcxQWFP-EnEJjVfwTeA3r7pFIQvfsq1Q` |
| `VAPID_SUBJECT` | `mailto:ch.nordin@jejetu.com` |
| `UPSTASH_REDIS_REST_URL` | *(från Upstash, steg 1)* |
| `UPSTASH_REDIS_REST_TOKEN` | *(från Upstash, steg 1)* |
| `CRON_SECRET` | *(välj en lång slumpmässig sträng, t.ex. `openssl rand -hex 32`)* |

Spara och **redeploya** projektet så env vars laddas.

> ⚠️ VAPID-nycklarna ovan är GENERERADE FÖR DIG och är dina permanenta nycklar. Byt inte dem efteråt — då måste alla användare prenumerera om.

## 3. Skapa cron-job.org (gratis, ~1 minut)

1. Gå till https://cron-job.org → "Sign Up"
2. Skapa nytt cron-jobb:
   - **Title**: `Regnradar push check`
   - **URL**: `https://DIN-VERCEL-DOMÄN.vercel.app/api/push/check?secret=DITT_CRON_SECRET`
   - **Execution schedule**: Every **5 minutes**
   - **Notifications**: Optional — slå på om du vill få mail om jobbet failar
3. Spara

Det första anropet kommer returnera `{"ok":true, "subscriptions":0, "results":[]}` eftersom inga är prenumererade ännu.

## 4. Testa på iPhone

1. Öppna `https://din-vercel-domän.vercel.app` i Safari på iPhone (iOS 16.4+)
2. Tryck **Dela** → **Lägg till på hemskärmen** (PWA måste installeras för att push ska fungera)
3. Öppna appen från hemskärmen
4. Tryck **Aktivera notiser** när prompten dyker upp → tillåt
5. Stäng appen helt (svep upp)
6. Vänta tills regn förväntas inom 20 min för din plats → du borde få notisen "Regnradar — Regn förväntas inom X minuter"

### Snabbtest utan att vänta på regn

Du kan trigga en check manuellt med curl:
```bash
curl "https://DIN-VERCEL-DOMÄN.vercel.app/api/push/check?secret=DITT_CRON_SECRET"
```

## 5. Felsökning

- **Inga notiser**: kolla cron-job.org-loggar (varje request loggas). Svarsmeddelandet visar `subscriptions: N` — är N=0, har ingen prenumererat än.
- **`{"error":"Unauthorized"}`**: cron-job.org skickade fel `secret`. Dubbelkolla att URL:en innehåller `?secret=...`.
- **`{"error":"VAPID keys not configured"}`**: env vars saknas på Vercel — redeploya efter att ha satt dem.
- **iPhone visar inte permission-prompten**: PWA:n måste vara installerad ("Lägg till på hemskärmen") — fungerar INTE i vanlig Safari-flik.

## Arkitektur i korthet

```
iPhone Safari (PWA)
    │
    │ 1. requestNotificationPermission() → granted
    │ 2. PushManager.subscribe({applicationServerKey: VAPID_PUBLIC_KEY})
    │ 3. POST /api/push/subscribe { subscription, lat, lng }
    ▼
Vercel Serverless (Node.js)
    └─→ Upstash Redis  [pushsub:<base64endpoint> = { keys, lat, lng, lastWarnAt }]

cron-job.org (var 5:e min)
    │ GET /api/push/check?secret=...
    ▼
Vercel Serverless (Node.js)
    │ för varje prenumeration:
    │   - hämta Open-Meteo minutely_15 för (lat, lng)
    │   - om mm/h ≥ 0.1 inom 20 min OCH cooldown 30 min har gått:
    │     - web-push.sendNotification(sub, {body: "Regn förväntas inom X minuter"})
    ▼
iPhone Safari Push Service
    └─→ Service Worker (sw.js) push-event → showNotification()
```
