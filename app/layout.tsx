import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voice Project",
  description: "Real-time speech transcription, translation, and AI minutes",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
