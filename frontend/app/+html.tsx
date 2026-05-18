// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="sv" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
        />
        <title>Regnradar</title>
        <meta name="description" content="Personlig regnradar med varningar" />

        {/* PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#2563EB" />
        <meta name="color-scheme" content="light" />

        {/* iOS PWA - Add to Home Screen */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Regnradar" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="icon" type="image/png" href="/favicon.png" />

        {/* Fonts: DM Sans */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&display=swap"
          rel="stylesheet"
        />

        {/* Leaflet CSS + JS via CDN (avoids SSR bundling issues) */}
        <link
          rel="stylesheet"
          href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
          crossOrigin=""
        />
        <script
          src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
          crossOrigin=""
          defer
        />

        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body { height: 100%; margin: 0; padding: 0; }
              body {
                font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
                background: #F8FAFC;
                color: #0F172A;
                -webkit-font-smoothing: antialiased;
                overscroll-behavior: none;
                overflow: hidden;
                display: flex;
                flex-direction: column;
              }
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }
              * { box-sizing: border-box; }
              .leaflet-container { font-family: 'DM Sans', sans-serif; background: #E2E8F0; }
              .leaflet-control-attribution { font-size: 9px !important; }
              .user-dot-wrap { position: relative; width: 18px; height: 18px; }
              .user-dot {
                position: absolute; inset: 0;
                width: 18px; height: 18px; border-radius: 50%;
                background: #2563EB; border: 3px solid #fff;
                box-shadow: 0 0 0 2px rgba(37,99,235,0.35), 0 2px 8px rgba(0,0,0,0.25);
                z-index: 2;
              }
              .user-pulse {
                position: absolute; left: -10px; top: -10px;
                width: 38px; height: 38px; border-radius: 50%;
                background: rgba(37,99,235,0.25);
                animation: pulse 2s ease-out infinite;
                z-index: 1;
              }
              @keyframes pulse {
                0% { transform: scale(0.4); opacity: 0.8; }
                100% { transform: scale(1.8); opacity: 0; }
              }
              @keyframes slideDown {
                from { transform: translateY(-120%); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
              }
              .banner-enter { animation: slideDown 0.45s cubic-bezier(0.2, 0.8, 0.2, 1); }
              button { font-family: inherit; cursor: pointer; }
              button:active { transform: scale(0.96); }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
