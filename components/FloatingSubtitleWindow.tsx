"use client";

import * as React from "react";

export interface FloatingSubtitleWindowProps {
  latestSourceText: string;
  latestTranslatedText: string;
  showTranslation: boolean;
  recording: boolean;
  /** Multiplier for the body text size (1.0 = default). Range ~0.75–1.5. */
  fontScale?: number;
}

/**
 * Rendered via ReactDOM.createPortal into a Document Picture-in-Picture window.
 * Styled inline so we don't depend on the parent document's stylesheets.
 */
export function FloatingSubtitleWindow({
  latestSourceText,
  latestTranslatedText,
  showTranslation,
  recording,
  fontScale = 1,
}: FloatingSubtitleWindowProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 8,
        padding: "16px 20px",
        background: "rgba(10, 10, 12, 0.95)",
        color: "#fafafa",
        fontFamily:
          'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
          fontSize: 11 * fontScale,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: recording ? "#f87171" : "#a1a1aa",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: recording ? "#ef4444" : "#52525b",
            animation: recording ? "fs-pulse 1.4s ease-in-out infinite" : "none",
          }}
        />
        <span>{recording ? "Live" : "Paused"}</span>
      </div>

      <div
        style={{
          fontSize: 22 * fontScale,
          lineHeight: 1.35,
          fontWeight: 600,
          color: "#ffffff",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: showTranslation ? "55%" : "85%",
          overflow: "hidden",
        }}
      >
        {latestSourceText || (
          <span style={{ color: "#71717a", fontWeight: 400 }}>正在监听…</span>
        )}
      </div>

      {showTranslation ? (
        <div
          style={{
            fontSize: 15 * fontScale,
            lineHeight: 1.4,
            color: "#d4d4d8",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "40%",
            overflow: "hidden",
          }}
        >
          {latestTranslatedText || (
            <span style={{ color: "#71717a" }}>翻译中…</span>
          )}
        </div>
      ) : null}

      <style>{`
        @keyframes fs-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>
    </div>
  );
}

export default FloatingSubtitleWindow;
