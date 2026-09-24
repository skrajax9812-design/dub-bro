import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const sg = Space_Grotesk({ subsets: ["latin"], variable: "--font-sg" });
const jb = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb" });

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
