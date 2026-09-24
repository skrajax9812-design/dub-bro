import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Fonts are self-hosted from the @fontsource packages instead of next/font/google
 * so the UI renders correctly with no network access at build/dev time.
 */
const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-inter",
  display: "swap",
});
const sg = localFont({
  src: "../../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
  weight: "300 700",
  variable: "--font-sg",
  display: "swap",
});
const jb = localFont({
  src: [
    { path: "../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2", weight: "400" },
    { path: "../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2", weight: "500" },
    { path: "../../node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2", weight: "700" },
  ],
  variable: "--font-jb",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DUBFORGE — Unlimited AI Video Dubbing. Any Length. Any Language.",
  description:
    "The open AI dubbing engine with no 30-second cap. FFmpeg remuxing, Faster-Whisper ASR, chunked neural translation, Edge-TTS neural voices and dynamic tempo sync — dub hour-long videos, watermark-free.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${sg.variable} ${jb.variable}`}>
      <body className="bg-void font-sans text-zinc-100 antialiased grain">
        {children}
      </body>
    </html>
  );
}
