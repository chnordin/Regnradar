// @ts-nocheck
/* eslint-disable */
import { useEffect, useMemo, useRef, useState, useCallback } from "react";

// Leaflet is loaded dynamically (client-side only) to avoid SSR "window is not defined"
let L: any = null;

// ─── Constants ────────────────────────────────────────────────────────────────
const PRIMARY = "#2563EB";
const PRIMARY_DARK = "#1D4ED8";
const TEXT = "#0F172A";
const MUTED = "#64748B";
const BG = "#F8FAFC";
const CARD = "#FFFFFF";
const BORDER = "#E2E8F0";

// (Removed: radar pixel-sampling helpers — Open-Meteo is now the only
// precipitation data source for both past and forecast.)
function _unused_rgbToDbz(r: number, g: number, b: number, a: number): number {
  // Hard cutoffs for "no echo".
  if (a < 40) return -10;

  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const v = max; // HSV value
  const s = max === 0 ? 0 : (max - min) / max; // saturation
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  // Near-white / very desaturated pale pixel → treat as no rain.
  if (v > 0.9 && s < 0.18) return -10;
  // Semi-transparent pixel near the alpha cutoff → trace at most, count as zero.
  if (a < 80 && s < 0.4) return -10;

  // Blue family (h ~ 180-260) — the dominant Universal Blue palette.
  if (h >= 170 && h < 260) {
    // "darkness" combines low brightness with high saturation. The darker /
    // more saturated the blue, the heavier the rain.
    const darkness = (1 - v) * 0.7 + s * 0.3;
    if (darkness < 0.10) return -10; // very light → no rain
    if (darkness < 0.22) return 8;   // light blue   → ~0.15 mm/h
    if (darkness < 0.38) return 20;  // medium-light → ~0.7 mm/h
    if (darkness < 0.52) return 30;  // medium blue  → ~3 mm/h
    if (darkness < 0.66) return 38;  // dark blue    → ~8 mm/h
    if (darkness < 0.80) return 45;  // very dark    → ~20 mm/h
    return 52;                        // navy/black   → ~40 mm/h
  }

  // Edge cases: brighter palette regions used in some schemes / extreme cells.
  if (h >= 40 && h < 70) return 42;  // yellow  → ~15 mm/h
  if (h >= 15 && h < 40) return 50;  // orange  → ~30 mm/h
  if (h < 15 || h >= 340) return 55; // red     → ~50 mm/h
  if (h >= 280 && h < 340) return 60; // magenta → ~70 mm/h

  return -10;
}

function dbzToMmh(dbz: number): number {
  if (dbz <= 0) return 0;
  // Marshall-Palmer Z = 200 R^1.6 → R = (Z/200)^(1/1.6)
  const Z = Math.pow(10, dbz / 10);
  return Math.max(0, Math.pow(Z / 200, 1 / 1.6));
}

function _unused_latLngToTilePx(lat: number, lng: number, zoom: number, tileSize = 512) {
  const n = Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return {
    tileX: Math.floor(x),
    tileY: Math.floor(y),
    px: Math.floor((x - Math.floor(x)) * tileSize),
    py: Math.floor((y - Math.floor(y)) * tileSize),
  };
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function formatMmh(v: number): string {
  if (v < 0.05) return "0,0";
  if (v < 1) return v.toFixed(1).replace(".", ",");
  return v.toFixed(1).replace(".", ",");
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Regnradar() {
  const mapEl = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const radarLayersRef = useRef<Set<any>>(new Set());
  const activeFadeRef = useRef<number | null>(null);

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [city, setCity] = useState<string>("Hämtar plats…");
  const [geoError, setGeoError] = useState<string | null>(null);

  const [frames, setFrames] = useState<
    { time: number; path: string; host: string; isNowcast: boolean }[]
  >([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const playTimerRef = useRef<any>(null);
  const scrubResumeRef = useRef<number | null>(null);
  // Tracks whether this is the very first frame-list fetch. We only seek to
  // "now" on the initial load — subsequent refreshes preserve the running
  // animation index so the loop never resets mid-cycle.
  const firstFetchRef = useRef(true);

  // ─── Derive per-frame intensities from Open-Meteo precip ───────────────────
  // For each radar frame, look up the nearest Open-Meteo `minutely_15`
  // precipitation slot and use that value. This drives the bar heights and
  // the `currentMmh` readout.
  // (Defined further below, after `precip` state — moved there to satisfy
  //  the temporal-dead-zone rules.)
  // Open-Meteo 15-min precipitation forecast — authoritative intensity source
  const [precip, setPrecip] = useState<{ time: number; mmh: number }[]>([]);
  const [precipError, setPrecipError] = useState<string | null>(null);
  // 30-second tick so the wall-clock-relative slot window slides smoothly.
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  // ─── Build the BAR TIMELINE = 15-minute slots spanning now-15min → now+2h ──
  // This is the source-of-truth for the graph and the animation. Bars are
  // always ≥ 8 (currently 10 slots @ 15-min spacing over 2h 15min). Each slot
  // carries an mmh value sampled from Open-Meteo (0 if no data).
  const slots = useMemo(() => {
    const nowS = Date.now() / 1000;
    const stepS = 15 * 60;
    const start = Math.floor((nowS - 15 * 60) / stepS) * stepS;
    const end = nowS + 2 * 3600;
    const out: { time: number; mmh: number; isFuture: boolean }[] = [];
    for (let t = start; t <= end + 60; t += stepS) {
      let mmh = 0;
      if (precip.length) {
        let bestDt = Infinity;
        let bestMmh = 0;
        for (const p of precip) {
          const dt = Math.abs(p.time - t);
          if (dt < bestDt) {
            bestDt = dt;
            bestMmh = p.mmh;
          }
        }
        // Snap only when within ±10 min of the slot, otherwise leave at 0.
        if (bestDt <= 10 * 60) mmh = bestMmh;
      }
      out.push({ time: t, mmh, isFuture: t > nowS });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precip, nowTick]);
  // intensities (per radar-frame) is no longer used for bars, but kept for any
  // legacy consumers (currently none). Bars come from `slots` above.
  const intensities = useMemo<(number | null)[]>(
    () => frames.map(() => null),
    [frames]
  );
  const [graphOpen, setGraphOpen] = useState(true);
  const [warning, setWarning] = useState<{ minutes: number; mmh: number } | null>(null);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [showPushPrompt, setShowPushPrompt] = useState(false);
  const [installHint, setShowInstallHint] = useState(false);
  const [notifToast, setNotifToast] = useState<string | null>(null);

  // Auto-dismiss the notification toast after 2.5s
  useEffect(() => {
    if (!notifToast) return;
    const id = setTimeout(() => setNotifToast(null), 2500);
    return () => clearTimeout(id);
  }, [notifToast]);

  // ─── Service worker registration & wait for Leaflet (loaded via CDN) ────────
  const [leafletReady, setLeafletReady] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Wait for Leaflet (loaded via <script> in +html.tsx) to be available
    const checkL = () => {
      const w = window as any;
      if (w.L) {
        L = w.L;
        setLeafletReady(true);
        return true;
      }
      return false;
    };
    if (!checkL()) {
      const id = setInterval(() => {
        if (checkL()) clearInterval(id);
      }, 100);
      setTimeout(() => clearInterval(id), 15000);
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((e) => console.warn("SW register failed", e));
    }
    if ("Notification" in window) {
      setPushPermission(Notification.permission);
      if (Notification.permission === "default") {
        // Delay prompt for better UX
        const t = setTimeout(() => setShowPushPrompt(true), 2500);
        return () => clearTimeout(t);
      }
    }
    // iOS install hint - only if not already installed (no standalone mode)
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone =
      (window.navigator as any).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    if (isIos && !isStandalone) {
      const seen = localStorage.getItem("rr_install_seen");
      if (!seen) {
        setTimeout(() => setShowInstallHint(true), 4500);
      }
    }
  }, []);

  // ─── Geolocation + reverse geocode ──────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setGeoError("Geolokalisering stöds inte");
      setCoords({ lat: 59.3293, lng: 18.0686 });
      setCity("Stockholm");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setCoords({ lat: latitude, lng: longitude });
        // Reverse geocode
        fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&accept-language=sv&zoom=10`,
          { headers: { Accept: "application/json" } }
        )
          .then((r) => r.json())
          .then((data) => {
            const a = data?.address || {};
            const name =
              a.city ||
              a.town ||
              a.village ||
              a.municipality ||
              a.county ||
              a.suburb ||
              a.state ||
              "Min plats";
            setCity(name);
          })
          .catch(() => setCity("Min plats"));
      },
      (err) => {
        console.warn("Geo error", err);
        setGeoError(err.message);
        setCoords({ lat: 59.3293, lng: 18.0686 });
        setCity("Stockholm (standard)");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  // ─── Initialize Leaflet map ─────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletReady || !L) return;
    if (!coords || !mapEl.current || mapRef.current) return;

    const map = L.map(mapEl.current, {
      center: [coords.lat, coords.lng],
      zoom: 7,
      minZoom: 4,
      maxZoom: 11,
      zoomControl: false,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap",
      maxZoom: 18,
    }).addTo(map);
    L.control.zoom({ position: "topright" }).addTo(map);

    // User marker
    const icon = L.divIcon({
      className: "user-marker",
      html: `<div class="user-dot-wrap"><div class="user-pulse"></div><div class="user-dot"></div></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    const m = L.marker([coords.lat, coords.lng], { icon, interactive: false }).addTo(map);

    mapRef.current = map;
    userMarkerRef.current = m;

    // Cleanup
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords?.lat, coords?.lng, leafletReady]);

  // ─── Fetch frames from Rain Viewer ──────────────────────────────────────────
  // We keep only the last 15 min of past frames so the animation loop is short
  // and tightly focused on "very recent + near-future" rain.
  const fetchFrames = useCallback(async () => {
    try {
      const r = await fetch("https://api.rainviewer.com/public/weather-maps.json", {
        cache: "no-store",
      });
      const data = await r.json();
      const host = data.host || "https://tilecache.rainviewer.com";
      const cutoff = Date.now() / 1000 - 15 * 60; // keep only last 15 min of past
      const past = (data?.radar?.past || [])
        .filter((f: any) => f.time >= cutoff)
        .map((f: any) => ({
          time: f.time,
          path: f.path,
          host,
          isNowcast: false,
        }));
      const nowcast = (data?.radar?.nowcast || []).map((f: any) => ({
        time: f.time,
        path: f.path,
        host,
        isNowcast: true,
      }));
      const all = [...past, ...nowcast];
      setFrames(all);
      // currentIdx now indexes `slots` (Open-Meteo timeline), not `frames`,
      // so we don't reset it here on radar-frame refresh. A separate effect
      // below seeks to the "now" slot when slots first become available.
    } catch (e) {
      console.warn("RainViewer fetch failed", e);
    }
  }, []);

  useEffect(() => {
    fetchFrames();
    const id = setInterval(fetchFrames, 5 * 60 * 1000); // refresh every 5 min
    return () => clearInterval(id);
  }, [fetchFrames]);

  // ─── Render current radar frame as a tile layer (strict single-layer) ──────
  // Maintains AT MOST one previous "outgoing" layer + one new "incoming" layer.
  // On every frame change ALL other tracked layers are removed immediately and
  // any in-progress cross-fade is cancelled — guarantees no ghost stacking
  // during rapid scrubbing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !L || !frames.length) return;
    // Find the radar frame whose timestamp is closest to the current slot's
    // time. This decouples the long animation (cycling through 10 bars over
    // 2 h 15 min) from the much shorter radar coverage.
    const slot = slots[currentIdx];
    if (!slot) return;
    let f = frames[0];
    let bestDt = Math.abs(frames[0].time - slot.time);
    for (let i = 1; i < frames.length; i++) {
      const dt = Math.abs(frames[i].time - slot.time);
      if (dt < bestDt) {
        bestDt = dt;
        f = frames[i];
      }
    }
    if (!f) return;

    const TARGET_OPACITY = 0.7;
    const FADE_MS = 350;

    // 1. Cancel any in-progress fade animation immediately.
    if (activeFadeRef.current) {
      cancelAnimationFrame(activeFadeRef.current);
      activeFadeRef.current = null;
    }

    // 2. Snapshot existing layers. Keep only the MOST RECENT one as the
    //    outgoing partner for the cross-fade — wipe all others immediately
    //    so they cannot stack as ghosts.
    const existing = Array.from(radarLayersRef.current);
    const outgoing = existing.length ? existing[existing.length - 1] : null;
    for (const layer of existing) {
      if (layer === outgoing) continue;
      try {
        layer.setOpacity(0);
        map.removeLayer(layer);
      } catch {}
      radarLayersRef.current.delete(layer);
    }

    // 3. Add the new layer at opacity 0.
    const url = `${f.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
    const incoming = L.tileLayer(url, {
      tileSize: 256,
      opacity: 0,
      zIndex: 401,
      maxNativeZoom: 7,
      minNativeZoom: 0,
      maxZoom: 18,
      fadeAnimation: false,
      keepBuffer: 4,
      updateWhenIdle: false,
      attribution: "© RainViewer",
    });
    incoming.addTo(map);
    radarLayersRef.current.add(incoming);

    let fallbackId: any = null;
    let started = false;

    const removeOutgoing = () => {
      if (!outgoing) return;
      try {
        outgoing.setOpacity(0);
        map.removeLayer(outgoing);
      } catch {}
      radarLayersRef.current.delete(outgoing);
    };

    const startFade = () => {
      if (started) return;
      started = true;
      if (fallbackId) clearTimeout(fallbackId);

      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
      const outStart = outgoing ? (outgoing.options.opacity ?? TARGET_OPACITY) : 0;
      const t0 = performance.now();

      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / FADE_MS);
        const e = easeOutCubic(p);
        try {
          incoming.setOpacity(TARGET_OPACITY * e);
          if (outgoing) outgoing.setOpacity(outStart * (1 - e));
        } catch {}
        if (p < 1) {
          activeFadeRef.current = requestAnimationFrame(tick);
        } else {
          activeFadeRef.current = null;
          removeOutgoing();
        }
      };
      activeFadeRef.current = requestAnimationFrame(tick);
    };

    incoming.on("load", startFade);
    // Fallback if 'load' never fires (e.g. all tiles cached).
    fallbackId = setTimeout(startFade, 800);

    return () => {
      // Cancel pending fade / fallback. We do NOT touch radarLayersRef here —
      // the next effect run will handle aggressive cleanup of every leftover
      // layer so that even fast scrubbing converges to a single active layer.
      if (activeFadeRef.current) {
        cancelAnimationFrame(activeFadeRef.current);
        activeFadeRef.current = null;
      }
      if (fallbackId) clearTimeout(fallbackId);
    };
  }, [frames, currentIdx, slots]);

  // ─── Animation loop ─────────────────────────────────────────────────────────
  // The animation cycles through `slots` (the 15-min Open-Meteo timeline),
  // not `frames` (which only spans the radar past+nowcast and can be very
  // short). Map tile rendering finds the nearest radar frame for each slot.
  useEffect(() => {
    if (!playing || !slots.length) return;
    playTimerRef.current = setInterval(() => {
      setCurrentIdx((i) => (i + 1) % slots.length);
    }, 400);
    return () => clearInterval(playTimerRef.current);
  }, [playing, slots.length]);

  // ─── On first slot load, seek to the "now" slot so the user starts at the
  //     present moment of the timeline (not the leftmost past slot). ─────────
  useEffect(() => {
    if (!firstFetchRef.current) return;
    if (!slots.length) return;
    firstFetchRef.current = false;
    const nowS = Date.now() / 1000;
    let bestIdx = 0;
    let bestDt = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const dt = Math.abs(slots[i].time - nowS);
      if (dt < bestDt) {
        bestDt = dt;
        bestIdx = i;
      }
    }
    setCurrentIdx(bestIdx);
  }, [slots.length]);

  // ─── Fetch precipitation forecast from Open-Meteo (every 15 min) ────────────
  useEffect(() => {
    if (!coords) return;
    let cancelled = false;
    const { lat, lng } = coords;

    const fetchPrecip = async () => {
      // Abort-controlled 8-second timeout so a hung fetch never blocks the UI.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?` +
          `latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
          `&minutely_15=precipitation&past_hours=1&forecast_hours=3&timezone=auto`;
        const r = await fetch(url, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeoutId);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const times: string[] = data?.minutely_15?.time || [];
        const values: (number | null)[] = data?.minutely_15?.precipitation || [];
        const utcOffset = Number(data?.utc_offset_seconds || 0);
        const nowS = Date.now() / 1000;
        const parsed = times
          .map((t, i) => {
            const ts = Math.floor(new Date(t + "Z").getTime() / 1000) - utcOffset;
            const mm15 = values[i] ?? 0;
            return { time: ts, mmh: Math.max(0, mm15 * 4) };
          })
          .filter((p) => p.time >= nowS - 15 * 60 && p.time <= nowS + 2 * 3600 + 60);

        if (typeof console !== "undefined") {
          // eslint-disable-next-line no-console
          console.log(
            "[Regnradar] Open-Meteo OK tz=" + data?.timezone +
              " offset=" + utcOffset + "s parsed=" + parsed.length
          );
        }
        if (!cancelled) {
          setPrecip(parsed);
          setPrecipError(null);
        }
      } catch (e: any) {
        clearTimeout(timeoutId);
        const msg = e?.name === "AbortError" ? "timeout (8s)" : (e?.message || String(e));
        // eslint-disable-next-line no-console
        console.warn("[Regnradar] Open-Meteo fetch failed:", msg);
        if (!cancelled) {
          // Fall back to radar-only by leaving precip empty + flagging the error
          // so the UI can show a discreet inline notice instead of hanging.
          setPrecip([]);
          setPrecipError(msg);
        }
      }
    };

    fetchPrecip();
    const id = setInterval(fetchPrecip, 15 * 60 * 1000); // refresh every 15 min
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coords?.lat, coords?.lng]);

  // (Legacy pixel-sampling kept disabled — Open-Meteo is the authoritative source now.)

  // ─── Pixel-sampling removed: Open-Meteo is the only precipitation source ────
  // The Open-Meteo fetch above already returns past_hours=3 + forecast_hours=3
  // worth of minutely_15 precipitation, which covers both past and future on
  // the graph and intensity readout.

  // ─── Rain warning — uses Open-Meteo: any of next 2 quarters > 0.1 mm/h ──────
  useEffect(() => {
    if (!precip.length) {
      setWarning(null);
      return;
    }
    const now = Date.now() / 1000;
    // Sort future entries by time, take the next two 15-min intervals.
    const future = precip
      .filter((p) => p.time > now)
      .sort((a, b) => a.time - b.time)
      .slice(0, 2);
    let foundMinutes: number | null = null;
    let foundMmh = 0;
    for (const p of future) {
      const dt = (p.time - now) / 60;
      if (dt > 0 && dt <= 30 && p.mmh > 0.1) {
        if (foundMinutes === null || dt < foundMinutes) {
          foundMinutes = dt;
          foundMmh = p.mmh;
        }
      }
    }
    if (foundMinutes !== null && foundMinutes <= 30) {
      setWarning({ minutes: Math.max(1, Math.round(foundMinutes)), mmh: foundMmh });
      if (typeof window !== "undefined" && Notification.permission === "granted") {
        const lastSent = Number(sessionStorage.getItem("rr_last_warn") || "0");
        if (Date.now() - lastSent > 5 * 60 * 1000) {
          sessionStorage.setItem("rr_last_warn", String(Date.now()));
          navigator.serviceWorker?.controller?.postMessage({
            type: "SHOW_NOTIFICATION",
            title: "Regnradar",
            body: `Regn inom ${Math.round(foundMinutes)} min (${formatMmh(foundMmh)} mm/h)`,
          });
        }
      }
    } else {
      setWarning(null);
    }
  }, [precip]);

  // ─── Current intensity — slot-based readout, refreshes via the `nowTick`
  //    state above (re-evaluated as `slots` recomputes every 30 s). ──────────
  const currentMmh = useMemo(() => {
    return slots[currentIdx]?.mmh ?? 0;
  }, [slots, currentIdx]);

  // Tween the displayed mm/h value smoothly when target changes
  const [displayedMmh, setDisplayedMmh] = useState(0);
  const displayedRef = useRef(0);
  const tweenRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
    const start = displayedRef.current;
    const target = currentMmh;
    if (Math.abs(start - target) < 0.01) {
      displayedRef.current = target;
      setDisplayedMmh(target);
      return;
    }
    const t0 = performance.now();
    const dur = 320;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const v = start + (target - start) * ease(p);
      displayedRef.current = v;
      setDisplayedMmh(v);
      if (p < 1) tweenRafRef.current = requestAnimationFrame(tick);
    };
    tweenRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
    };
  }, [currentMmh]);

  // ─── Handlers ───────────────────────────────────────────────────────────────
  const togglePlay = () => setPlaying((p) => !p);
  const step = (dir: number) => {
    setPlaying(false);
    setCurrentIdx((i) => (i + dir + frames.length) % frames.length);
  };

  const requestPushPermission = async () => {
    setShowPushPrompt(false);
    if (!("Notification" in window)) return;
    try {
      const p = await Notification.requestPermission();
      setPushPermission(p);
    } catch {}
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  // currentFrame is now derived from the current SLOT (Open-Meteo timeline)
  // rather than the radar `frames` array. The badge shows the slot time so
  // the animation feels like scrubbing along a full ±2h timeline.
  const currentSlot = slots[currentIdx];
  const currentFrame = currentSlot
    ? { time: currentSlot.time, isNowcast: currentSlot.isFuture }
    : null;
  const isFuture = currentSlot?.isFuture;

  return (
    <div
      data-testid="regnradar-root"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: BG,
        color: TEXT,
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {/* Top header */}
      <div
        style={{
          padding: "12px 16px 10px",
          background: CARD,
          borderBottom: `1px solid ${BORDER}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            data-testid="city-name"
            style={{
              fontSize: 13,
              color: MUTED,
              fontWeight: 500,
              letterSpacing: 0.2,
              textTransform: "uppercase",
            }}
          >
            {city}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span
              data-testid="current-intensity"
              style={{ fontSize: 28, fontWeight: 700, color: TEXT, lineHeight: 1.1 }}
            >
              {formatMmh(displayedMmh)}
            </span>
            <span style={{ fontSize: 14, color: MUTED, fontWeight: 500 }}>mm/t</span>
            {displayedMmh < 0.05 && (
              <span style={{ fontSize: 13, color: MUTED, marginLeft: 8 }}>· Uppehåll</span>
            )}
          </div>
        </div>
        <button
          data-testid="notification-toggle-btn"
          aria-label="Notisinställningar"
          onClick={() => {
            if (typeof window === "undefined" || !("Notification" in window)) {
              setNotifToast("Notiser stöds inte i denna webbläsare");
              return;
            }
            if (Notification.permission === "granted") {
              setNotifToast("Notiser aktiva — du varnas innan regnet");
            } else if (Notification.permission === "denied") {
              setNotifToast("Notiser blockerade — aktivera i webbläsarinställningarna");
            } else {
              setShowPushPrompt(true);
            }
          }}
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            background:
              pushPermission === "granted"
                ? `${PRIMARY}15`
                : pushPermission === "denied"
                ? "#F1F5F9"
                : `${PRIMARY}15`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            cursor: "pointer",
            position: "relative",
          }}
        >
          <BellIcon
            color={
              pushPermission === "denied" ? MUTED : PRIMARY
            }
            size={22}
          />
          {pushPermission === "granted" && (
            <span
              style={{
                position: "absolute",
                bottom: 4,
                right: 4,
                width: 10,
                height: 10,
                borderRadius: 5,
                background: "#16A34A",
                border: "2px solid #fff",
              }}
            />
          )}
          {pushPermission === "denied" && (
            <span
              style={{
                position: "absolute",
                top: 6,
                right: 6,
                fontSize: 9,
                color: "#94A3B8",
                fontWeight: 700,
              }}
            >
              ✕
            </span>
          )}
        </button>
      </div>

      {/* Notification toast */}
      {notifToast && (
        <div
          data-testid="notif-toast"
          onClick={() => setNotifToast(null)}
          style={{
            position: "fixed",
            top: "calc(env(safe-area-inset-top) + 70px)",
            left: 16,
            right: 16,
            background: "rgba(15,23,42,0.92)",
            color: "#fff",
            padding: "10px 14px",
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 500,
            textAlign: "center",
            zIndex: 9000,
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
            animation: "slideDown 0.3s ease-out",
          }}
        >
          {notifToast}
        </div>
      )}

      {/* Warning banner */}
      {warning && (
        <div
          data-testid="rain-warning-banner"
          className="banner-enter"
          style={{
            background: PRIMARY,
            color: "#fff",
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            boxShadow: "0 2px 12px rgba(37,99,235,0.35)",
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              background: "rgba(255,255,255,0.18)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
            }}
          >
            !
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Regn inom {warning.minutes} minuter</div>
            <div style={{ fontSize: 12, opacity: 0.9 }}>
              Förväntad intensitet: {formatMmh(warning.mmh)} mm/h
            </div>
          </div>
          <button
            data-testid="dismiss-warning-btn"
            onClick={() => setWarning(null)}
            aria-label="Stäng"
            style={{
              background: "rgba(255,255,255,0.2)",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "6px 10px",
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            OK
          </button>
        </div>
      )}

      {/* Map */}
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <div ref={mapEl} data-testid="map-container" style={{ position: "absolute", inset: 0 }} />
        {/* Geo error overlay */}
        {geoError && (
          <div
            style={{
              position: "absolute",
              top: 10,
              left: 10,
              right: 10,
              background: "rgba(255,255,255,0.95)",
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              padding: "8px 12px",
              fontSize: 12,
              color: MUTED,
              boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
            }}
          >
            Plats nekad — visar Stockholm. Aktivera plats i webbläsaren för exakt regnvarning.
          </div>
        )}
        {/* Frame time overlay */}
        {currentFrame && (
          <div
            data-testid="frame-time"
            style={{
              position: "absolute",
              top: 12,
              left: 12,
              background: isFuture ? `${PRIMARY}E6` : "rgba(15,23,42,0.85)",
              color: "#fff",
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.3,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            {isFuture ? "Prognos · " : ""}
            {formatTime(currentFrame.time)}
          </div>
        )}
      </div>

      {/* Animation loopar automatiskt — ingen manuell play/pause behövs.
          (Scrub i grafen pausar tillfälligt och återupptar efter 3 s.) */}

      {/* Rain graph (collapsible) */}
      <div
        style={{
          background: CARD,
          borderTop: `1px solid ${BORDER}`,
          paddingBottom: 6,
        }}
      >
        <button
          data-testid="graph-toggle-btn"
          onClick={() => setGraphOpen((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            padding: "10px 16px",
            background: "transparent",
            border: "none",
            color: TEXT,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: 0.2 }}>
            Regnintensitet
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: MUTED,
              fontSize: 12,
            }}
          >
            {graphOpen ? "Dölj" : "Visa"}
            <Chevron open={graphOpen} />
          </span>
        </button>
        {graphOpen && (
          <div data-testid="rain-graph" style={{ padding: "0 12px 12px" }}>
            <RainGraph
              slots={slots}
              precipError={precipError}
              currentIdx={currentIdx}
            />
          </div>
        )}
      </div>

      {/* Push permission prompt */}
      {showPushPrompt && (
        <Modal onClose={() => setShowPushPrompt(false)}>
          <div style={{ padding: 20, maxWidth: 360 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                background: `${PRIMARY}15`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <BellIcon color={PRIMARY} size={28} />
            </div>
            <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>
              Få varning innan regnet
            </div>
            <div style={{ color: MUTED, fontSize: 14, lineHeight: 1.45, marginBottom: 18 }}>
              Tillåt notiser så meddelar vi dig när regn närmar sig din plats inom 20 minuter.
              Inga andra meddelanden, vi lovar.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                data-testid="push-skip-btn"
                onClick={() => setShowPushPrompt(false)}
                style={{
                  flex: 1,
                  background: "transparent",
                  color: MUTED,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 12,
                  padding: "12px 14px",
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                Inte nu
              </button>
              <button
                data-testid="push-allow-btn"
                onClick={requestPushPermission}
                style={{
                  flex: 1,
                  background: PRIMARY,
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  padding: "12px 14px",
                  fontWeight: 700,
                  fontSize: 14,
                  boxShadow: "0 4px 14px rgba(37,99,235,0.35)",
                }}
              >
                Tillåt notiser
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* iOS install hint */}
      {installHint && (
        <Modal
          onClose={() => {
            setShowInstallHint(false);
            localStorage.setItem("rr_install_seen", "1");
          }}
        >
          <div style={{ padding: 20, maxWidth: 360 }}>
            <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 8 }}>
              Lägg till på hemskärmen
            </div>
            <div style={{ color: MUTED, fontSize: 14, lineHeight: 1.45, marginBottom: 14 }}>
              För bästa upplevelse, installera Regnradar:
              <ol style={{ paddingLeft: 18, margin: "10px 0", color: TEXT }}>
                <li>Tryck på <strong>Dela</strong> i Safari</li>
                <li>Välj <strong>Lägg till på hemskärmen</strong></li>
                <li>Tryck <strong>Lägg till</strong></li>
              </ol>
            </div>
            <button
              data-testid="install-hint-close"
              onClick={() => {
                setShowInstallHint(false);
                localStorage.setItem("rr_install_seen", "1");
              }}
              style={{
                width: "100%",
                background: PRIMARY,
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "12px 14px",
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              OK, jag fattar
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────
function IconButton({
  children,
  onClick,
  primary,
  testID,
  ariaLabel,
}: any) {
  return (
    <button
      data-testid={testID}
      aria-label={ariaLabel}
      onClick={onClick}
      style={{
        width: primary ? 44 : 40,
        height: primary ? 44 : 40,
        borderRadius: primary ? 22 : 20,
        border: `1px solid ${primary ? "transparent" : BORDER}`,
        background: primary ? PRIMARY : "#fff",
        color: primary ? "#fff" : TEXT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: primary ? "0 4px 14px rgba(37,99,235,0.35)" : "none",
        transition: "transform 0.08s ease",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

function Timeline({
  frames,
  currentIdx,
  onSeek,
}: {
  frames: any[];
  currentIdx: number;
  onSeek: (i: number) => void;
}) {
  if (!frames.length) {
    return (
      <div style={{ height: 32, display: "flex", alignItems: "center", color: MUTED, fontSize: 12 }}>
        Laddar…
      </div>
    );
  }
  return (
    <div
      data-testid="timeline"
      style={{
        position: "relative",
        height: 32,
        display: "flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {frames.map((f, i) => {
        const active = i === currentIdx;
        const future = f.isNowcast;
        return (
          <button
            key={f.time + "_" + i}
            data-testid={`timeline-dot-${i}`}
            onClick={() => onSeek(i)}
            aria-label={formatTime(f.time)}
            style={{
              flex: 1,
              height: active ? 22 : 8,
              minHeight: 8,
              border: "none",
              padding: 0,
              background: active
                ? PRIMARY
                : future
                ? `${PRIMARY}55`
                : "#CBD5E1",
              borderRadius: 6,
              transition: "height 0.15s, background 0.15s",
              cursor: "pointer",
            }}
          />
        );
      })}
    </div>
  );
}

function RainGraph({
  slots,
  precipError,
  currentIdx,
}: {
  slots: { time: number; mmh: number; isFuture: boolean }[];
  precipError?: string | null;
  currentIdx: number;
}) {
  // 30-second tick so the wall-clock-relative bar styling refreshes smoothly.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!slots.length) {
    return (
      <div
        style={{
          height: 132,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          color: MUTED,
          fontSize: 12,
          gap: 4,
        }}
      >
        <span>{precipError ? "Kunde inte hämta prognos" : "Hämtar data…"}</span>
        {precipError && (
          <span style={{ fontSize: 10, opacity: 0.7 }}>
            {precipError} · försöker igen
          </span>
        )}
      </div>
    );
  }

  // ── Dynamic Y scale: peak * 1.25 with floor of 2.5 mm/h so the default
  //    "Duggregn / Lätt regn / Måttligt" band is visible when there's no rain.
  const peak = Math.max(0, ...slots.map((s) => s.mmh));
  const maxMmh = Math.max(2.5, peak * 1.25);
  const graphH = 120;
  const yFor = (v: number) => (1 - v / maxMmh) * graphH;
  const labelEvery = Math.max(1, Math.floor(slots.length / 6));

  // Intensity reference lines (mm/h). Shown only when they fit within the
  // current Y range.
  const allRefs = [
    { label: "Skyfall", value: 30 },
    { label: "Kraftigt", value: 10 },
    { label: "Måttligt", value: 2 },
    { label: "Lätt regn", value: 0.5 },
    { label: "Duggregn", value: 0.1 },
  ];
  const refs = allRefs.filter((r) => r.value <= maxMmh);

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          position: "relative",
          height: graphH,
          display: "flex",
          alignItems: "flex-end",
          gap: 3,
          paddingLeft: 70,
          paddingRight: 4,
          background: "linear-gradient(180deg, #F8FAFC 0%, #fff 100%)",
          borderRadius: 8,
          borderBottom: `1px solid ${BORDER}`,
        }}
      >
        {/* Y-axis reference lines */}
        {refs.map((ref) => {
          const y = yFor(ref.value);
          return (
            <div
              key={ref.label}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: y,
                borderTop: `1px dashed ${BORDER}`,
                pointerEvents: "none",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  left: 4,
                  top: -8,
                  fontSize: 10,
                  color: MUTED,
                  background: "rgba(255,255,255,0.85)",
                  padding: "0 4px",
                  borderRadius: 3,
                  whiteSpace: "nowrap",
                }}
              >
                {ref.label} {formatMmh(ref.value)}
              </span>
            </div>
          );
        })}
        {/* Bars — one per 15-min slot. Even zero-rain bars get a 2 px floor so
            the graph never looks empty. */}
        {slots.map((s, i) => {
          const active = i === currentIdx;
          const dataH = s.mmh > 0 ? (s.mmh / maxMmh) * (graphH - 4) : 0;
          const h = Math.max(2, dataH);
          const intensityRatio = s.mmh / Math.max(0.001, maxMmh);
          const color =
            s.mmh < 0.05
              ? s.isFuture ? "#CBD5E1" : "#94A3B8"
              : interpolateBlue(intensityRatio);
          return (
            <div
              key={s.time + "_b_" + i}
              data-testid={`bar-${i}`}
              style={{
                flex: 1,
                height: h,
                background: color,
                borderRadius: 3,
                minWidth: 2,
                outline: active ? `2px solid ${PRIMARY}` : "none",
                outlineOffset: 0,
                opacity: s.isFuture ? 0.85 : 1,
                position: "relative",
                transition: "height 0.25s ease-out, background 0.25s ease-out",
              }}
              title={`${formatTime(s.time)} · ${formatMmh(s.mmh)} mm/h`}
            />
          );
        })}
      </div>
      {/* X axis labels */}
      <div
        style={{
          display: "flex",
          gap: 3,
          paddingLeft: 70,
          paddingRight: 4,
          marginTop: 4,
          fontSize: 9,
          color: MUTED,
        }}
      >
        {slots.map((s, i) => (
          <div
            key={s.time + "_t_" + i}
            style={{
              flex: 1,
              textAlign: "center",
              visibility: i % labelEvery === 0 ? "visible" : "hidden",
              fontWeight: i === currentIdx ? 700 : 500,
              color: i === currentIdx ? PRIMARY : MUTED,
              whiteSpace: "nowrap",
            }}
          >
            {formatTime(s.time)}
          </div>
        ))}
      </div>
    </div>
  );
}

function interpolateBlue(t: number): string {
  // 0 → light blue, 1 → deep blue/violet
  const clamped = Math.max(0, Math.min(1, t));
  // Light: #BFDBFE → mid: #2563EB → high: #1E1B4B
  if (clamped < 0.5) {
    const k = clamped / 0.5;
    return lerpColor("#BFDBFE", "#2563EB", k);
  }
  return lerpColor("#2563EB", "#1E1B4B", (clamped - 0.5) / 0.5);
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
function hexToRgb(h: string): [number, number, number] {
  const m = h.replace("#", "");
  return [
    parseInt(m.substr(0, 2), 16),
    parseInt(m.substr(2, 2), 16),
    parseInt(m.substr(4, 2), 16),
  ];
}

function Modal({ children, onClose }: any) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.55)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 9999,
        animation: "slideDown 0.25s ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          width: "100%",
          maxWidth: 480,
          paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)",
          boxShadow: "0 -8px 32px rgba(0,0,0,0.15)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ─── Inline SVG icons ───────────────────────────────────────────────────────
function Play() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function Pause() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
function Triangle({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      {dir === "left" ? (
        <path d="M15 6l-6 6 6 6V6z" />
      ) : (
        <path d="M9 6v12l6-6-6-6z" />
      )}
    </svg>
  );
}
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transition: "transform 0.2s", transform: open ? "rotate(0deg)" : "rotate(180deg)" }}
    >
      <polyline points="6 15 12 9 18 15" />
    </svg>
  );
}
function CloudIcon({ color, size = 24 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19a4.5 4.5 0 0 0 0-9c-.3 0-.6 0-.9.1A6 6 0 0 0 5 11v.5A4 4 0 0 0 6 19h11.5z" />
      <path d="M9 19v3" />
      <path d="M13 19v3" />
    </svg>
  );
}
function BellIcon({ color, size = 24 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
