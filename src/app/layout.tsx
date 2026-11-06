import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

// IBM Plex Sans (mockup font), self-hosted — no requests to Google.
const plex = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex",
  display: "swap",
});

// 17: one codebase serves many firms, so nothing outside a signed-in firm names one (the root title was Kushal's
// from 01). Signed-in staff see their own firm through the (app) layout; the console says "Platform".
export const metadata: Metadata = {
  title: { default: "CA Document Vault", template: "%s · CA Document Vault" },
  description: "Document collection and vault for CA firms",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" className={plex.variable}>
      <body>{children}</body>
    </html>
  );
}
