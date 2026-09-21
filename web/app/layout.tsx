import type { Metadata } from "next";
import { Archivo_Narrow, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

export const viewport = { themeColor: "#070b16" };

export const metadata: Metadata = {
  title: "Pitchfork — simulated BTC-USD",
  description:
    "Real-time simulated BTC-USD market: seeded feed, order book, candles, and per-connection adaptive delivery.",
  openGraph: {
    title: "Pitchfork — simulated BTC-USD",
    description:
      "Real-time simulated BTC-USD market: seeded feed, order book, candles, and per-connection adaptive delivery.",
  },
};

/**
 * Type, all Google Fonts via `next/font/google` at build time (no runtime CDN):
 * Archivo Narrow for the UI (`font-ui`, and the `--font-sans` body default),
 * IBM Plex Mono for numbers (`font-mono`: tabular figures, fixed decimals).
 * Each exposes a `--font-*` variable that `app/globals.css` reads — the server
 * and the client resolve the same family on first paint, so there is no
 * webfont swap to mistake for jank.
 */
const sans = Archivo_Narrow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

const ui = Archivo_Narrow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <head>
        <script dangerouslySetInnerHTML={{ __html: "(function(){try{var t=localStorage.getItem(\"rt-crypto-trading:theme\");document.documentElement.dataset.theme=t===\"light\"?\"light\":\"dark\"}catch(e){document.documentElement.dataset.theme=\"dark\"}})();" }} />
      </head>
      <body className={`flex min-h-full flex-col antialiased ${sans.variable} ${mono.variable} ${ui.variable}`}>
        {children}
      </body>
    </html>
  );
}
