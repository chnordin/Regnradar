# Regnradar — Personlig regnradar PWA

## Vision
A mobile-first, installable PWA that gives Swedish users a fast glance at incoming rain at their exact location — installed directly from Safari to the iPhone home screen, no App Store needed.

## Core Features (built)
1. **Animated rain radar** — Leaflet + OpenStreetMap base map with Rain Viewer radar tiles (past 2h + 30 min nowcast). Auto-loops every 600 ms.
2. **GPS-based centering** — On load, prompts for location and centers the map. Falls back to Stockholm if denied.
3. **Reverse geocoded city name** — Via Nominatim (sv locale) shown at the top.
4. **Rain intensity graph** — Bars per radar frame, computed by sampling the radar tile pixel at the user's GPS coords. Includes "måttligt" (1 mm/h) and "kraftigt" (5 mm/h) reference lines. Current frame highlighted; synced with animation.
5. **Current intensity readout** — Big "X,X mm/t" at the top.
6. **Rain warning** — Polls every 5 min and on every frame update, checks nowcast frames 0-20 min ahead. Shows in-app banner + fires a Web Push notification (via registered service worker) once permission is granted.
7. **PWA install** — `manifest.webmanifest`, apple-touch-icon, `apple-mobile-web-app-capable`, service worker, custom iOS install hint modal.
8. **Controls** — Play/pause, prev/next, scrubbable timeline with dots (past = grey, current = blue, nowcast = light blue).
9. **Collapsible graph panel**.

## Tech Stack
- **Frontend**: React (via Expo Router web target as static-served PWA shell), TypeScript, vanilla DOM elements (not React Native components — this is a web PWA).
- **Map**: Leaflet 1.9.4 loaded via CDN to avoid SSR bundling issues.
- **Radar data**: `https://api.rainviewer.com/public/weather-maps.json` (no key).
- **Geocoding**: Nominatim public API.
- **Push**: Web Push API + Service Worker (no backend push server — notifications fire locally via `serviceWorker.controller.postMessage`).
- **Storage**: localStorage / sessionStorage for install-hint and rate-limiting warnings.
- **No backend usage** — all data sources are public.

## Design
- Light theme, DM Sans, primary `#2563EB`.
- Map takes majority of screen, header at top, controls/timeline/graph stacked below.
- Animated user dot with pulse ring.
- Banner alert slides in from top when rain is imminent.

## File Structure
- `/app/frontend/app/+html.tsx` — HTML shell with PWA meta, Leaflet CSS + JS via CDN, DM Sans font, global styles.
- `/app/frontend/app/index.tsx` — Main app (~1100 lines).
- `/app/frontend/public/manifest.webmanifest` — PWA manifest.
- `/app/frontend/public/sw.js` — Service worker (caching + push handler).
- `/app/frontend/public/icon-*.png`, `apple-touch-icon.png` — generated rain cloud icons.

## Next Possible Enhancements
- Persisted favorite locations.
- Daily rain summary (commercial: monetize as "weekly weather digest" subscription).
- Hourly rain prediction beyond the 30-min nowcast (via additional API).
- Background sync to fire push even when app is closed (requires VAPID + push server backend).
- Smart "good day to bike" / "bring umbrella" suggestions (potential premium tier).

## Commercial / Growth Angle
Since this is intentionally backend-free, the upgrade path is a Pro tier that adds:
- Push notifications that work when the app is closed (requires real Web Push server with VAPID).
- Hourly/daily forecast (paid weather API).
- Multiple saved locations.
This keeps the free experience snappy while creating a clear paid upgrade for power users.
