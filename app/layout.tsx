import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

export const metadata: Metadata = {
  title: "Voice Project",
  description: "Real-time speech transcription, translation, and AI minutes",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={geist.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
