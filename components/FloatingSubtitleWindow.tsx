"use client";

import * as React from "react";

export interface FloatingSubtitleItem {
  id: string;
  sourceText: string;
  translatedText: string;
  isLive?: boolean;
}

export interface FloatingSubtitleWindowProps {
  /** Newest item last. Render top-to-bottom; auto-scroll keeps the live one in view. */
  items: FloatingSubtitleItem[];
  showTranslation: boolean;
  recording: boolean;
  /** Multiplier for the body text size (1.0 = default). Range ~0.75–1.5. */
  fontScale?: number;
}

/**
 * Rendered via ReactDOM.createPortal into a Document Picture-in-Picture window.
 * Shows a scrolling history of recent utterances (newest at bottom) so a
 * single floating window keeps several seconds of context, not just one
 * sentence.
 */
export function FloatingSubtitleWindow({
  items,
  showTranslation,
  recording,
  fontScale = 1,
}: FloatingSubtitleWindowProps) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);

  // Pin the scroller to the bottom whenever the list grows or the live
  // utterance's text changes.
  const liveSig = items.map((i) => i.id + ":" + i.sourceText + "|" + i.translatedText).join("\n");
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [liveSig]);

  const showEmpty = items.length === 0;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 16px 14px",
        background: "rgba(10, 10, 12, 0.96)",
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
          fontSize: 11 * fontScale,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: recording ? "#f87171" : "#a1a1aa",
          flexShrink: 0,
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
        ref={scrollerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          paddingRight: 4,
          // Make the cards lean toward the bottom — newest content is right
          // above the user's eyes.
          justifyContent: "flex-end",
        }}
      >
        {showEmpty ? (
          <div style={{ color: "#71717a", fontSize: 14 * fontScale }}>
            正在监听…
          </div>
        ) : (
          items.map((item) => {
            const dim = item.isLive ? 1 : 0.55;
            return (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  opacity: dim,
                  transition: "opacity 200ms",
                }}
              >
                {item.sourceText ? (
                  <div
                    style={{
                      fontSize: (item.isLive ? 13 : 12) * fontScale,
                      lineHeight: 1.35,
                      color: "#a1a1aa",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {item.sourceText}
                  </div>
                ) : null}
                {showTranslation && item.translatedText ? (
                  <div
                    style={{
                      fontSize: (item.isLive ? 22 : 18) * fontScale,
                      lineHeight: 1.35,
                      fontWeight: item.isLive ? 600 : 500,
                      color: "#ffffff",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {item.translatedText}
                  </div>
                ) : !showTranslation && item.sourceText ? (
                  <div
                    style={{
                      fontSize: (item.isLive ? 22 : 18) * fontScale,
                      lineHeight: 1.35,
                      fontWeight: item.isLive ? 600 : 500,
                      color: "#ffffff",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {item.sourceText}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

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
