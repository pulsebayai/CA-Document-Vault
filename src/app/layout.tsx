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

export const metadata: Metadata = {
  title: "CA Document Vault — Kushal Associates",
  description: "Document collection and vault for Kushal Associates",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN" className={plex.variable}>
      <body>{children}</body>
    </html>
  );
}
