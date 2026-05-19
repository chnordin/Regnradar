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

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [city, setCity] = useState<string>("Hämtar plats…");
  const [geoError, setGeoError] = useState<string | null>(null);

  const [frames, setFrames] = useState<
    { time: number; path: string; host: string; isNowcast: boolean }[]
  >([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  // ─── Single shared frame index ─────────────────────────────────────────────
  // ONE setInterval below drives this index. Every tick: increment, swap the
  // radar tile to frames[frameIdx], and move the graph marker to the X
  // corresponding to that frame's TIME (so radar tile and graph marker are
  // perfectly synced — there is no separate slot animation).
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const playTimerRef = useRef<any>(null);
  const scrubResumeRef = useRef<number | null>(null);
  // Tracks whether this is the very first frame-list fetch. We only seek to
  // "now" on the initial load — subsequent refreshes preserve the running
  // animation index so the loop never resets mid-cycle.
  const firstFetchRef = useRef(true);
  // ─── Graph marker DOM ref ─────────────────────────────────────────────────
  // The active-frame marker on the area chart is a vertical <line> whose x1/x2
  // are updated by direct setAttribute inside the single animation interval.
  const markerLineRef = useRef<SVGLineElement | null>(null);
  // Refs used by the interval tick so it can read the latest frames array and
  // log/inspect the current index without depending on render-closures.
  const framesRef = useRef<typeof frames>([]);
  const frameIdxRef = useRef(0);
  framesRef.current = frames;
  frameIdxRef.current = frameIdx;
  // Move the graph marker to the X position corresponding to a frame's TIME.
  // This is the ONLY way the marker moves — no separate slot index animation.
  const setMarkerToFrame = (idx: number) => {
    const f = framesRef.current[idx];
    if (!f) return;
    const x = graphXForTime(f.time);
    if (markerLineRef.current && isFinite(x)) {
      markerLineRef.current.setAttribute("x1", String(x));
      markerLineRef.current.setAttribute("x2", String(x));
    }
  };

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
      const past = (data?.radar?.past || []).map((f: any) => ({
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
  // ─── Radar tile rendering — SIMPLE INSTANT SWAP ────────────────────────────
  // No cross-fade, no load event, no RAF. Each tick: remove all existing
  // radar layers and add the new one at target opacity immediately. Leaflet
  // caches tiles internally so after the first loop everything is snappy.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !L || !frames.length) return;
    const f = frames[radarFrameIdx];
    if (!f) return;

    const url = `${f.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;

    // Remove all existing radar layers immediately.
    for (const layer of radarLayersRef.current) {
      try {
        map.removeLayer(layer);
      } catch {}
    }
    radarLayersRef.current.clear();

    // Add new layer at full target opacity straight away.
    const layer = L.tileLayer(url, {
      tileSize: 256,
      opacity: 0.7,
      zIndex: 401,
      maxNativeZoom: 7,
      minNativeZoom: 0,
      maxZoom: 18,
      fadeAnimation: false,
      keepBuffer: 4,
      updateWhenIdle: false,
      attribution: "© RainViewer",
    });
    layer.addTo(map);
    radarLayersRef.current.add(layer);
  }, [frames, radarFrameIdx]);

  // ─── Animation loop ─────────────────────────────────────────────────────────
  // The animation cycles through `slots` (the 15-min Open-Meteo timeline),
  // not `frames` (which only spans the radar past+nowcast and can be very
  // short). Map tile rendering finds the nearest radar frame for each slot.
  // The marker line is updated via direct DOM setAttribute — no React state
  // or RAF for the marker position.
  useEffect(() => {
    slotsLengthRef.current = slots.length;
  }, [slots.length]);
  useEffect(() => {
    framesLengthRef.current = frames.length;
    // Clamp radarFrameIdx whenever frames update so we don't index past end.
    if (frames.length > 0) {
      setRadarFrameIdx((i) => (i >= frames.length ? 0 : i));
    } else {
      setRadarFrameIdx(0);
    }
  }, [frames.length]);
  // ─── Animation loop ─────────────────────────────────────────────────────────
  // The interval runs from mount and is ONLY recreated when `playing` toggles.
  // It never depends on `slots.length` or `frames.length` — those are read
  // from refs inside the tick callback. This guarantees the loop is not
  // killed by every 30 s `nowTick` re-render or 5-min frame refresh.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      // ── DEBUG: emit each tick so we can see in the console whether the
      //    interval is alive and which radar frame is being shown. ──────────
      try {
        const n = framesLengthRef.current;
        const i = currentRadarIdxRef.current;
        const f = currentFramesRef.current[i];
        const url = f ? `${f.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` : "(no frame)";
        // eslint-disable-next-line no-console
        console.log(
          `[regnradar] tick idx=${i}/${Math.max(0, n - 1)} (n=${n}) url=${url}`
        );
      } catch {}
      // Advance graph-marker slot index
      setCurrentIdx((i) => {
        const n = slotsLengthRef.current;
        if (n <= 0) return i;
        const newIdx = (i + 1) % n;
        setMarkerToSlotIdx(newIdx);
        return newIdx;
      });
      // Advance radar frame: simple (i+1) % n. With many frames now fetched
      // (full RainViewer past + nowcast) this gives a clean forward loop.
      setRadarFrameIdx((i) => {
        const n = framesLengthRef.current;
        if (n <= 0) return 0;
        const next = (i + 1) % n;
        currentRadarIdxRef.current = next;
        return next;
      });
    };
    playTimerRef.current = setInterval(tick, 800);
    return () => {
      if (playTimerRef.current) {
        clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [playing]);

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
    setMarkerToSlotIdx(bestIdx);
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
        {/* ── DEBUG counter overlay (top-left). Shows radarFrameIdx / total
            and the last 24 chars of the active radar URL. Updates on every
            React re-render = every tick (since setRadarFrameIdx is called). */}
        <div
          data-testid="debug-counter"
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            zIndex: 1200,
            background: "rgba(15,23,42,0.85)",
            color: "#fff",
            fontFamily: "monospace",
            fontSize: 11,
            padding: "4px 8px",
            borderRadius: 6,
            pointerEvents: "none",
            maxWidth: "60%",
            lineHeight: 1.3,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {`idx=${radarFrameIdx} / ${frames.length}\n${
            frames[radarFrameIdx]
              ? frames[radarFrameIdx].path.slice(-30)
              : "(no frame)"
          }`}
        </div>
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
              markerLineRef={markerLineRef}
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

// Layout constants for the area chart — module-level so the parent's
// setInterval can compute marker X positions consistently.
const GRAPH_W = 1000;
const GRAPH_H = 160;
const GRAPH_PAD_LEFT = 56;
const GRAPH_PAD_RIGHT = 16;
const GRAPH_PAD_TOP = 10;
const GRAPH_PAD_BOTTOM = 22;
const GRAPH_INNER_W = GRAPH_W - GRAPH_PAD_LEFT - GRAPH_PAD_RIGHT;
const GRAPH_INNER_H = GRAPH_H - GRAPH_PAD_TOP - GRAPH_PAD_BOTTOM;
function graphXForIdx(i: number, n: number): number {
  if (n <= 1) return GRAPH_PAD_LEFT + GRAPH_INNER_W / 2;
  return GRAPH_PAD_LEFT + (i / (n - 1)) * GRAPH_INNER_W;
}

function RainGraph({
  slots,
  precipError,
  currentIdx,
  markerLineRef,
}: {
  slots: { time: number; mmh: number; isFuture: boolean }[];
  precipError?: string | null;
  currentIdx: number;
  markerLineRef?: React.MutableRefObject<SVGLineElement | null>;
}) {
  // 30-second tick so labels/now-line refresh as wall-clock time advances.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (!slots.length) {
    return (
      <div
        style={{
          height: 160,
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

  // Dynamic Y scale with sensible floor so the default reference band shows.
  const peak = Math.max(0, ...slots.map((s) => s.mmh));
  const maxMmh = Math.max(2.5, peak * 1.25);
  const yFor = (v: number) =>
    GRAPH_PAD_TOP + (1 - Math.min(1, v / maxMmh)) * GRAPH_INNER_H;

  type P = { x: number; y: number };
  const points: P[] = slots.map((s, i) => ({
    x: graphXForIdx(i, slots.length),
    y: yFor(Math.max(0, s.mmh)),
  }));

  // Cardinal spline path with Y clamping to the chart area.
  function buildPath(pts: P[], close: boolean): string {
    if (!pts.length) return "";
    if (pts.length === 1) {
      const p = pts[0];
      const baseY = yFor(0);
      return close
        ? `M ${p.x} ${baseY} L ${p.x} ${p.y} L ${p.x} ${baseY} Z`
        : `M ${p.x} ${p.y}`;
    }
    const baseY = yFor(0);
    const topY = GRAPH_PAD_TOP;
    const clampY = (y: number) => Math.max(topY, Math.min(baseY, y));
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const t = 0.5;
      const cp1x = p1.x + ((p2.x - p0.x) / 6) * t * 2;
      let cp1y = p1.y + ((p2.y - p0.y) / 6) * t * 2;
      const cp2x = p2.x - ((p3.x - p1.x) / 6) * t * 2;
      let cp2y = p2.y - ((p3.y - p1.y) / 6) * t * 2;
      cp1y = clampY(cp1y);
      cp2y = clampY(cp2y);
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(
        2
      )} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    if (close) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      d += ` L ${last.x.toFixed(2)} ${baseY.toFixed(2)} L ${first.x.toFixed(
        2
      )} ${baseY.toFixed(2)} Z`;
    }
    return d;
  }

  const linePath = buildPath(points, false);
  const fillPath = buildPath(points, true);

  // Initial marker X — subsequent updates come from the parent's setInterval
  // via setAttribute on the ref. No React state, no RAF, no tween.
  const initialMarkerX = graphXForIdx(currentIdx, slots.length);

  // Reference lines that fit in the current Y range
  const allRefs = [
    { label: "Skyfall", value: 30 },
    { label: "Kraftigt", value: 10 },
    { label: "Måttligt", value: 2 },
    { label: "Lätt regn", value: 0.5 },
    { label: "Duggregn", value: 0.1 },
  ];
  const refs = allRefs.filter((r) => r.value <= maxMmh);

  const labelEvery = Math.max(1, Math.floor(slots.length / 6));

  return (
    <div style={{ position: "relative" }}>
      <svg
        data-testid="rain-graph-svg"
        viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
        preserveAspectRatio="none"
        style={{
          width: "100%",
          height: GRAPH_H,
          display: "block",
          background: "linear-gradient(180deg, #F8FAFC 0%, #fff 100%)",
          borderRadius: 8,
          touchAction: "none",
          WebkitTapHighlightColor: "transparent",
          userSelect: "none",
        }}
      >
        <defs>
          <linearGradient id="rainFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
            <stop offset="100%" stopColor={PRIMARY} stopOpacity={0.04} />
          </linearGradient>
        </defs>

        {/* Y-axis reference dashed lines */}
        {refs.map((r) => (
          <line
            key={"ref_" + r.label}
            x1={GRAPH_PAD_LEFT}
            x2={GRAPH_W - GRAPH_PAD_RIGHT}
            y1={yFor(r.value)}
            y2={yFor(r.value)}
            stroke={BORDER}
            strokeDasharray="3 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Baseline */}
        <line
          x1={GRAPH_PAD_LEFT}
          x2={GRAPH_W - GRAPH_PAD_RIGHT}
          y1={yFor(0)}
          y2={yFor(0)}
          stroke={BORDER}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {/* Area fill */}
        <path d={fillPath} fill="url(#rainFill)" />

        {/* Line */}
        <path
          d={linePath}
          stroke={PRIMARY}
          strokeWidth={2}
          fill="none"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Active frame marker — vertical dashed line. The parent's animation
            setInterval updates `x1`/`x2` via setAttribute on every tick. */}
        <line
          ref={(el) => {
            if (markerLineRef) markerLineRef.current = el;
            if (el && isFinite(initialMarkerX)) {
              el.setAttribute("x1", String(initialMarkerX));
              el.setAttribute("x2", String(initialMarkerX));
            }
          }}
          y1={GRAPH_PAD_TOP}
          y2={GRAPH_H - GRAPH_PAD_BOTTOM}
          stroke={PRIMARY}
          strokeWidth={2}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
          opacity={0.85}
        />
      </svg>

      {/* HTML overlay for non-stretched Y labels */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {refs.map((r) => (
          <div
            key={"lbl_" + r.label}
            style={{
              position: "absolute",
              left: 6,
              top: `calc(${(yFor(r.value) / GRAPH_H) * 100}% - 8px)`,
              fontSize: 11,
              color: MUTED,
              fontWeight: 500,
              background: "rgba(255,255,255,0.85)",
              padding: "0 4px",
              borderRadius: 3,
              whiteSpace: "nowrap",
            }}
          >
            {r.label} {formatMmh(r.value)}
          </div>
        ))}
      </div>

      {/* X axis labels */}
      <div
        style={{
          display: "flex",
          paddingLeft: `${(GRAPH_PAD_LEFT / GRAPH_W) * 100}%`,
          paddingRight: `${(GRAPH_PAD_RIGHT / GRAPH_W) * 100}%`,
          marginTop: 2,
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
