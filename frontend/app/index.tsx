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
const SAMPLE_ZOOM = 6; // zoom level used for intensity sampling

// Rain Viewer color scheme 2 (universal blue) dBZ approximation by hue
function rgbToDbz(r: number, g: number, b: number, a: number): number {
  if (a < 20) return -10; // no echo
  // Convert RGB to HSV
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  // Map hue to dBZ (approx for RainViewer scheme 2)
  // cyan(180) light → blue(220) → green(120) → yellow(60) → orange(30) → red(0) → magenta(300)
  if (max < 0.2) return -5;
  if (h >= 170 && h < 200) return 5; // cyan
  if (h >= 200 && h < 250) return 18; // blue
  if (h >= 90 && h < 170) return 28; // green
  if (h >= 40 && h < 70) return 38; // yellow
  if (h >= 15 && h < 40) return 48; // orange
  if (h < 15 || h >= 340) return 55; // red
  if (h >= 280 && h < 340) return 62; // magenta/violet
  return 10;
}

function dbzToMmh(dbz: number): number {
  if (dbz <= 0) return 0;
  // Marshall-Palmer Z = 200 R^1.6 → R = (Z/200)^(1/1.6)
  const Z = Math.pow(10, dbz / 10);
  return Math.max(0, Math.pow(Z / 200, 1 / 1.6));
}

function latLngToTilePx(lat: number, lng: number, zoom: number, tileSize = 512) {
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
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null);

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

  const [intensities, setIntensities] = useState<(number | null)[]>([]);
  // Open-Meteo 15-min precipitation forecast — authoritative intensity source
  const [precip, setPrecip] = useState<{ time: number; mmh: number }[]>([]);
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
      setCurrentIdx((idx) => {
        // jump to "now" (last past frame) on first load
        const lastPast = past.length - 1;
        return idx === 0 && lastPast >= 0 ? lastPast : Math.min(idx, all.length - 1);
      });
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
    const f = frames[currentIdx];
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
  }, [frames, currentIdx]);

  // ─── Animation loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || !frames.length) return;
    playTimerRef.current = setInterval(() => {
      setCurrentIdx((i) => (i + 1) % frames.length);
    }, 600);
    return () => clearInterval(playTimerRef.current);
  }, [playing, frames.length]);

  // ─── Fetch precipitation forecast from Open-Meteo (every 15 min) ────────────
  useEffect(() => {
    if (!coords) return;
    let cancelled = false;
    const { lat, lng } = coords;

    const fetchPrecip = async () => {
      try {
        const url =
          `https://api.open-meteo.com/v1/forecast?` +
          `latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
          `&minutely_15=precipitation&past_hours=3&forecast_hours=2&timezone=auto`;
        const r = await fetch(url, { cache: "no-store" });
        const data = await r.json();
        const times: string[] = data?.minutely_15?.time || [];
        const values: (number | null)[] = data?.minutely_15?.precipitation || [];
        // Open-Meteo returns naive local-time strings ("2026-02-18T15:30") in the
        // location's timezone. Parse as UTC then subtract utc_offset_seconds to
        // get the true UTC moment. Comparable to RainViewer's UTC frame stamps.
        const utcOffset = Number(data?.utc_offset_seconds || 0);
        const nowS = Date.now() / 1000;
        const parsed = times
          .map((t, i) => {
            const ts = Math.floor(new Date(t + "Z").getTime() / 1000) - utcOffset;
            const mm15 = values[i] ?? 0;
            return { time: ts, mmh: Math.max(0, mm15 * 4) };
          })
          .filter((p) => p.time >= nowS - 3 * 3600 && p.time <= nowS + 3 * 3600);

        // Debug: log raw times vs device time to verify alignment (user requested)
        if (typeof console !== "undefined") {
          const nowDev = new Date();
          const sample = times.slice(0, 3).concat(times.slice(-2));
          // eslint-disable-next-line no-console
          console.log(
            "[Regnradar] Open-Meteo tz=" +
              data?.timezone +
              " offset=" + utcOffset + "s" +
              " device(UTC)=" + nowDev.toISOString() +
              " device(local)=" + nowDev.toString().slice(0, 25) +
              " sample raw times=" + JSON.stringify(sample) +
              " parsed.length=" + parsed.length
          );
          if (parsed.length) {
            const nearest = parsed.reduce((best, p) =>
              Math.abs(p.time - nowS) < Math.abs(best.time - nowS) ? p : best
            );
            // eslint-disable-next-line no-console
            console.log(
              "[Regnradar] Nearest precip to now: mmh=" + nearest.mmh.toFixed(2) +
                " at " + new Date(nearest.time * 1000).toISOString()
            );
          }
        }

        if (!cancelled) setPrecip(parsed);
      } catch (e) {
        console.warn("Open-Meteo fetch failed", e);
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

  // ─── Current intensity — Open-Meteo value at the current 15-min interval ────
  // Always anchored to wall-clock NOW (independent of radar scrub position).
  // We pick the interval whose start time is closest to "now", preferring the
  // most recent past interval so the displayed mm/h matches what's currently
  // falling — exactly what the user sees on the radar above their location.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    // Re-evaluate every 30s so the readout follows wall-clock time
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  const currentMmh = useMemo(() => {
    if (!precip.length) return 0;
    const now = Date.now() / 1000;
    // Pick the most recent 15-min slot whose start is at or before `now`
    // (i.e. the slot we are currently INSIDE). Each slot covers [t, t+900s).
    // This is what the user actually sees on the radar above their head.
    let pick: { time: number; mmh: number } | null = null;
    for (const p of precip) {
      if (p.time <= now && (!pick || p.time > pick.time)) {
        pick = p;
      }
    }
    // Fallback: if no past/current slot found (e.g. user is before the first
    // returned entry), use the closest entry overall.
    if (!pick) {
      let bestDt = Infinity;
      for (const p of precip) {
        const dt = Math.abs(p.time - now);
        if (dt < bestDt) {
          bestDt = dt;
          pick = p;
        }
      }
    }
    return pick ? pick.mmh : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precip]);

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
  const currentFrame = frames[currentIdx];
  const isFuture = currentFrame?.isNowcast;

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

      {/* Floating play/pause on the map (no full controls bar — graph handles scrubbing) */}
      <button
        data-testid="play-pause-btn"
        aria-label={playing ? "Pausa" : "Spela"}
        onClick={togglePlay}
        style={{
          position: "absolute",
          right: 12,
          bottom: graphOpen ? 224 : 96,
          width: 44,
          height: 44,
          borderRadius: 22,
          border: "none",
          background: PRIMARY,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 4px 14px rgba(37,99,235,0.45)",
          zIndex: 500,
          transition: "bottom 0.25s ease",
        }}
      >
        {playing ? <Pause /> : <Play />}
      </button>

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
              frames={frames}
              precip={precip}
              currentIdx={currentIdx}
              onScrub={(idx, isFinal) => {
                if (scrubResumeRef.current) {
                  clearTimeout(scrubResumeRef.current);
                  scrubResumeRef.current = null;
                }
                if (!isFinal) {
                  setPlaying(false);
                  setCurrentIdx(idx);
                } else {
                  scrubResumeRef.current = setTimeout(() => {
                    setPlaying(true);
                    scrubResumeRef.current = null;
                  }, 3000) as unknown as number;
                }
              }}
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
  frames,
  precip,
  currentIdx,
  onScrub,
}: {
  frames: any[];
  precip: { time: number; mmh: number }[];
  currentIdx: number;
  onScrub?: (idx: number, isFinal: boolean) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const scrubbingRef = useRef(false);
  const tweenRafRef = useRef<number | null>(null);

  // ── Animated displayed precipitation values ─────────────────────────────────
  // Tween from previous to new precip mmh values over 500ms (ease-in-out cubic).
  // Keyed by time so we can match values across refreshes even if the array
  // shifts as the 15-min window rolls forward.
  const [displayed, setDisplayed] = useState<{ time: number; mmh: number }[]>(precip);
  const fromRef = useRef<{ time: number; mmh: number }[]>(precip);

  useEffect(() => {
    // If lengths or time-keys differ, snap to the new array (no morph between
    // structurally different sets — but values within will still tween via the
    // smooth path between refreshes).
    const sameLen = displayed.length === precip.length;
    const sameKeys =
      sameLen && displayed.every((d, i) => d.time === precip[i].time);
    if (!sameKeys) {
      fromRef.current = precip;
      setDisplayed(precip);
      return;
    }
    // Snapshot current displayed as the new "from" and tween mmh values.
    fromRef.current = displayed.map((d) => ({ ...d }));
    if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
    const dur = 500;
    const t0 = performance.now();
    const ease = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = ease(p);
      const out = precip.map((tgt, i) => {
        const src = fromRef.current[i];
        if (!src) return tgt;
        return { time: tgt.time, mmh: src.mmh + (tgt.mmh - src.mmh) * e };
      });
      setDisplayed(out);
      if (p < 1) tweenRafRef.current = requestAnimationFrame(tick);
      else tweenRafRef.current = null;
    };
    tweenRafRef.current = requestAnimationFrame(tick);
    return () => {
      if (tweenRafRef.current) cancelAnimationFrame(tweenRafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [precip]);

  if (!frames.length) {
    return (
      <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: MUTED, fontSize: 12 }}>
        Hämtar data…
      </div>
    );
  }

  // Layout constants — drawn into an SVG with a fixed viewBox, stretched to width
  const W = 1000;
  const H = 160;
  const PAD_LEFT = 56;
  const PAD_RIGHT = 16;
  const PAD_TOP = 10;
  const PAD_BOTTOM = 22;
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  // ── Time-based X axis: span the radar timeline window ──────────────────────
  const tMin = frames[0].time;
  const tMax = frames[frames.length - 1].time;
  const xForTime = (t: number) =>
    PAD_LEFT + ((t - tMin) / Math.max(1, tMax - tMin)) * innerW;

  const maxMmh = Math.max(
    5.5,
    ...displayed.map((p) => p.mmh),
    ...precip.map((p) => p.mmh)
  );
  const yFor = (v: number) => PAD_TOP + (1 - v / maxMmh) * innerH;

  // Build smooth path through precipitation points (sorted, clipped to range)
  type P = { x: number; y: number };
  const points: P[] = displayed
    .filter((p) => p.time >= tMin - 600 && p.time <= tMax + 600)
    .sort((a, b) => a.time - b.time)
    .map((p) => ({ x: xForTime(p.time), y: yFor(Math.max(0, p.mmh)) }));

  // Cardinal spline path (smooth) — tension 0.5, with Y-clamping safety
  function buildPath(pts: P[], close: boolean) {
    if (pts.length === 0) return "";
    if (pts.length === 1) {
      const p = pts[0];
      return close
        ? `M ${p.x} ${yFor(0)} L ${p.x} ${p.y} L ${p.x} ${yFor(0)} Z`
        : `M ${p.x} ${p.y}`;
    }
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    const baseY = yFor(0);
    const topY = PAD_TOP;
    const clampY = (y: number) => Math.max(topY, Math.min(baseY, y));
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
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    if (close) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      d += ` L ${last.x.toFixed(2)} ${baseY.toFixed(2)} L ${first.x.toFixed(2)} ${baseY.toFixed(2)} Z`;
    }
    return d;
  }

  const linePath = buildPath(points, false);
  const fillPath = buildPath(points, true);

  // Locate where the nowcast (future) section begins — to lighten that area
  const nowcastStartIdx = frames.findIndex((f: any) => f.isNowcast);
  const nowcastX = nowcastStartIdx > 0 ? xForTime(frames[nowcastStartIdx].time) : null;

  // ── Current frame marker — positioned by the current radar frame's time ────
  const curT = frames[currentIdx]?.time ?? tMin;
  const curX = xForTime(curT);
  // Interpolate the curve's Y at the marker's X for a nice circle on the path
  let curY: number | null = null;
  if (points.length >= 2) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (curX >= a.x && curX <= b.x) {
        const r = (curX - a.x) / Math.max(1e-6, b.x - a.x);
        curY = a.y + (b.y - a.y) * r;
        break;
      }
    }
    if (curY === null) {
      curY = curX <= points[0].x ? points[0].y : points[points.length - 1].y;
    }
  } else if (points.length === 1) {
    curY = points[0].y;
  }

  // X-axis labels — pick a few evenly spaced frame times for context
  const labelEvery = Math.max(1, Math.floor(frames.length / 6));

  const refs = [
    { label: "kraftigt", value: 5 },
    { label: "måttligt", value: 1 },
  ];

  const yPct = (v: number) => ((PAD_TOP + (1 - v / maxMmh) * innerH) / H) * 100;
  const xPctTime = (t: number) => (xForTime(t) / W) * 100;

  // ── Scrubbing: compute frame index from a touch/mouse X position ───────────
  const indexFromClientX = (clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return currentIdx;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return currentIdx;
    const localX = clientX - rect.left;
    const xInVB = (localX / rect.width) * W;
    const innerX = xInVB - PAD_LEFT;
    const ratio = Math.max(0, Math.min(1, innerX / innerW));
    return Math.round(ratio * Math.max(0, frames.length - 1));
  };

  const handleScrubStart = (clientX: number) => {
    if (!onScrub) return;
    scrubbingRef.current = true;
    onScrub(indexFromClientX(clientX), false);
  };
  const handleScrubMove = (clientX: number) => {
    if (!scrubbingRef.current || !onScrub) return;
    onScrub(indexFromClientX(clientX), false);
  };
  const handleScrubEnd = () => {
    if (!scrubbingRef.current || !onScrub) return;
    scrubbingRef.current = false;
    onScrub(currentIdx, true);
  };

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        overflow: "hidden",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <svg
        ref={svgRef}
        data-testid="rain-graph-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{
          display: "block",
          width: "100%",
          height: 160,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          WebkitTapHighlightColor: "transparent",
          cursor: onScrub ? "ew-resize" : "default",
        }}
        onTouchStart={(e) => {
          if (e.cancelable) e.preventDefault();
          if (e.touches.length) handleScrubStart(e.touches[0].clientX);
        }}
        onTouchMove={(e) => {
          if (e.cancelable) e.preventDefault();
          if (e.touches.length) handleScrubMove(e.touches[0].clientX);
        }}
        onTouchEnd={(e) => {
          if (e.cancelable) e.preventDefault();
          handleScrubEnd();
        }}
        onTouchCancel={(e) => {
          if (e.cancelable) e.preventDefault();
          handleScrubEnd();
        }}
        onMouseDown={(e) => {
          handleScrubStart(e.clientX);
        }}
        onMouseMove={(e) => {
          if (scrubbingRef.current) handleScrubMove(e.clientX);
        }}
        onMouseUp={handleScrubEnd}
        onMouseLeave={() => {
          if (scrubbingRef.current) handleScrubEnd();
        }}
      >
        <defs>
          <linearGradient id="rainFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PRIMARY} stopOpacity="0.85" />
            <stop offset="55%" stopColor={PRIMARY} stopOpacity="0.35" />
            <stop offset="100%" stopColor={PRIMARY} stopOpacity="0.02" />
          </linearGradient>
          {/* Clip everything that should never render below the baseline or above the ceiling */}
          <clipPath id="graphClip">
            <rect
              x={PAD_LEFT}
              y={PAD_TOP}
              width={W - PAD_LEFT - PAD_RIGHT}
              height={yFor(0) - PAD_TOP}
            />
          </clipPath>
        </defs>

        {/* Nowcast band background */}
        {nowcastX !== null && (
          <rect
            x={nowcastX}
            y={PAD_TOP}
            width={W - PAD_RIGHT - nowcastX}
            height={innerH}
            fill={PRIMARY}
            fillOpacity={0.04}
          />
        )}

        {/* Reference lines */}
        {refs.map((r) => {
          if (r.value > maxMmh) return null;
          const y = yFor(r.value);
          return (
            <line
              key={r.label}
              x1={PAD_LEFT}
              y1={y}
              x2={W - PAD_RIGHT}
              y2={y}
              stroke={BORDER}
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* Baseline */}
        <line
          x1={PAD_LEFT}
          y1={yFor(0)}
          x2={W - PAD_RIGHT}
          y2={yFor(0)}
          stroke={BORDER}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />

        {/* Area fill — clipped so it can never render below baseline */}
        {points.length > 1 && (
          <path d={fillPath} fill="url(#rainFill)" clipPath="url(#graphClip)" />
        )}

        {/* Smooth line on top — also clipped to the plot area */}
        {points.length > 1 && (
          <path
            d={linePath}
            fill="none"
            stroke={PRIMARY}
            strokeWidth={2.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            clipPath="url(#graphClip)"
          />
        )}

        {/* Current frame indicator */}
        <line
          x1={curX}
          y1={PAD_TOP}
          x2={curX}
          y2={H - PAD_BOTTOM}
          stroke={PRIMARY}
          strokeWidth={1.5}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          opacity={0.55}
        />
        {curY != null && (
          <g>
            <circle
              cx={curX}
              cy={curY}
              r={9}
              fill={PRIMARY}
              fillOpacity={0.2}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={curX}
              cy={curY}
              r={4.5}
              fill="#fff"
              stroke={PRIMARY}
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>

      {/* HTML overlay for non-stretched labels */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {/* Y reference labels */}
        {refs.map((r) => {
          if (r.value > maxMmh) return null;
          return (
            <div
              key={"lbl_" + r.label}
              style={{
                position: "absolute",
                left: 6,
                top: `calc(${yPct(r.value)}% - 8px)`,
                fontSize: 11,
                color: MUTED,
                fontWeight: 500,
                background: "rgba(255,255,255,0.85)",
                padding: "0 4px",
                borderRadius: 3,
                whiteSpace: "nowrap",
              }}
            >
              {r.label} {r.value}
            </div>
          );
        })}
        {/* X-axis time labels — position by frame time on the new time axis */}
        {frames.map((f: any, i: number) => {
          if (i % labelEvery !== 0) return null;
          const active = i === currentIdx;
          return (
            <div
              key={"xt_" + f.time + "_" + i}
              style={{
                position: "absolute",
                left: `${xPctTime(f.time)}%`,
                transform: "translateX(-50%)",
                bottom: 0,
                fontSize: 11,
                color: active ? PRIMARY : MUTED,
                fontWeight: active ? 700 : 500,
                whiteSpace: "nowrap",
              }}
            >
              {formatTime(f.time)}
            </div>
          );
        })}
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
