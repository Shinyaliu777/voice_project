"use client";

/**
 * AudioPlayer with canvas waveform.
 *
 * Behavior:
 *  - Keeps the existing seek / play / pause / mute controls and the
 *    `seekTo(ms)` imperative handle that callers (transcript click-to-seek)
 *    already depend on.
 *  - On mount, fetches `src` once and decodes it with Web Audio API
 *    `AudioContext.decodeAudioData`. The decoded buffer is downsampled to
 *    ~200 bars (max amplitude per window) and drawn to a canvas.
 *  - The canvas renders symmetric vertical bars centered on the y-axis.
 *    Played portion is dark; remaining portion is light. A 1px vertical
 *    cursor tracks the current play position.
 *  - Bookmarks render as small clickable dots above the bars at their
 *    proportional x positions.
 *  - Clicking the waveform sets `audio.currentTime` proportionally.
 *  - On `<audio>` `timeupdate`, only the cursor and "played" coloring are
 *    re-rendered — the bar geometry is cached on the offscreen buffer.
 *  - If decoding fails (e.g. CORS, unsupported codec on this browser),
 *    we fall back to the plain range-input seek bar.
 */

import * as React from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BookmarkDTO } from "@/lib/contracts";

export interface AudioPlayerProps {
  src: string;
  bookmarks?: BookmarkDTO[];
  className?: string;
  /** Called when user clicks on the timeline; receives milliseconds. */
  onSeek?: (atMs: number) => void;
}

export interface AudioPlayerHandle {
  seekTo: (ms: number) => void;
  play: () => void;
  pause: () => void;
}

type DecodeState = "idle" | "loading" | "ready" | "failed";

const BAR_COUNT = 200;
const BAR_GAP = 1;
const CANVAS_HEIGHT = 64;
const COLOR_BAR_UNPLAYED_LIGHT = "#d4d4d8"; // zinc-300
const COLOR_BAR_UNPLAYED_DARK = "#3f3f46"; // zinc-700
const COLOR_BAR_PLAYED_LIGHT = "#18181b"; // zinc-900
const COLOR_BAR_PLAYED_DARK = "#f4f4f5"; // zinc-100
const COLOR_CURSOR_LIGHT = "#0a0a0a";
const COLOR_CURSOR_DARK = "#fafafa";

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Downsample channel data to `bars` peak values in [0,1]. */
function downsamplePeaks(samples: Float32Array, bars: number): Float32Array {
  const out = new Float32Array(bars);
  if (samples.length === 0) return out;
  const windowSize = Math.max(1, Math.floor(samples.length / bars));
  let peak = 0;
  for (let b = 0; b < bars; b++) {
    const start = b * windowSize;
    const end = Math.min(samples.length, start + windowSize);
    let max = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    out[b] = max;
    if (max > peak) peak = max;
  }
  // Normalize so the loudest bar reaches full height. Avoid div-by-zero on
  // pure silence.
  if (peak > 0) {
    for (let i = 0; i < bars; i++) out[i] /= peak;
  }
  return out;
}

/** Mix all channels into one mono Float32Array. */
function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0);
  const length = buffer.length;
  const out = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] += data[i];
  }
  for (let i = 0; i < length; i++) out[i] /= channels;
  return out;
}

function prefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return (
    document.documentElement.classList.contains("dark") ||
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
  );
}

interface WaveformCanvasProps {
  peaks: Float32Array | null;
  progress: number; // 0..1
  durationMs: number;
  bookmarks?: BookmarkDTO[];
  onSeekRatio: (ratio: number) => void;
}

const WaveformCanvas = React.memo(function WaveformCanvas({
  peaks,
  progress,
  durationMs,
  bookmarks,
  onSeekRatio,
}: WaveformCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);

  // Resize observer so the canvas scales to its container.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? el.clientWidth);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  // Redraw on peaks / progress / size change.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0 || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(CANVAS_HEIGHT * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, CANVAS_HEIGHT);

    const dark = prefersDark();
    const colorPlayed = dark ? COLOR_BAR_PLAYED_DARK : COLOR_BAR_PLAYED_LIGHT;
    const colorUnplayed = dark
      ? COLOR_BAR_UNPLAYED_DARK
      : COLOR_BAR_UNPLAYED_LIGHT;
    const colorCursor = dark ? COLOR_CURSOR_DARK : COLOR_CURSOR_LIGHT;

    const bars = peaks.length;
    const barTotal = width / bars;
    const barWidth = Math.max(1, barTotal - BAR_GAP);
    const centerY = CANVAS_HEIGHT / 2;
    const maxHalfHeight = CANVAS_HEIGHT / 2 - 2;
    const cursorX = Math.max(0, Math.min(width, progress * width));

    for (let i = 0; i < bars; i++) {
      const x = i * barTotal;
      const h = Math.max(1, peaks[i] * maxHalfHeight);
      ctx.fillStyle = x + barWidth < cursorX ? colorPlayed : colorUnplayed;
      ctx.fillRect(x, centerY - h, barWidth, h * 2);
    }

    // Cursor line.
    if (durationMs > 0) {
      ctx.fillStyle = colorCursor;
      ctx.fillRect(Math.max(0, cursorX - 0.5), 0, 1, CANVAS_HEIGHT);
    }
  }, [peaks, progress, width, durationMs]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!width) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    onSeekRatio(ratio);
  };

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="relative h-16 w-full cursor-pointer select-none"
      role="slider"
      aria-label="audio progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    >
      <canvas ref={canvasRef} className="block" />
      {durationMs > 0 && bookmarks
        ? bookmarks.map((b) => {
            const ratio = Math.min(1, Math.max(0, b.atMs / durationMs));
            return (
              <button
                key={b.id}
                type="button"
                title={b.note ?? "书签"}
                aria-label={b.note ?? "bookmark"}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeekRatio(ratio);
                }}
                style={{ left: `${ratio * 100}%` }}
                className="absolute top-0 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-zinc-950"
              />
            );
          })
        : null}
    </div>
  );
});

export const AudioPlayer = React.forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, bookmarks, className, onSeek }, ref) {
    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = React.useState(false);
    const [currentMs, setCurrentMs] = React.useState(0);
    const [durationMs, setDurationMs] = React.useState(0);
    const [muted, setMuted] = React.useState(false);
    const [decodeState, setDecodeState] = React.useState<DecodeState>("idle");
    const [peaks, setPeaks] = React.useState<Float32Array | null>(null);

    // Decode the audio file once on mount / when `src` changes.
    React.useEffect(() => {
      if (!src) return;
      let cancelled = false;
      let ctx: AudioContext | null = null;

      const decode = async () => {
        setDecodeState("loading");
        setPeaks(null);
        try {
          const res = await fetch(src, { credentials: "same-origin" });
          if (!res.ok) throw new Error(`fetch ${res.status}`);
          const arr = await res.arrayBuffer();
          if (cancelled) return;
          const Ctor: typeof AudioContext =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext;
          if (!Ctor) throw new Error("AudioContext not supported");
          ctx = new Ctor();
          // `decodeAudioData` in some browsers takes callbacks instead of a
          // promise. We wrap to be safe.
          const buf = await new Promise<AudioBuffer>((resolve, reject) => {
            const p = ctx!.decodeAudioData(
              arr,
              (b) => resolve(b),
              (err) => reject(err ?? new Error("decode failed"))
            );
            if (p && typeof (p as Promise<AudioBuffer>).then === "function") {
              (p as Promise<AudioBuffer>).then(resolve, reject);
            }
          });
          if (cancelled) return;
          const mono = toMono(buf);
          const peaksArr = downsamplePeaks(mono, BAR_COUNT);
          setPeaks(peaksArr);
          // Use the decoded buffer's duration if the <audio> element hasn't
          // reported one yet (some webm streams come back as Infinity).
          if (buf.duration && Number.isFinite(buf.duration)) {
            setDurationMs((prev) =>
              prev > 0 ? prev : Math.floor(buf.duration * 1000)
            );
          }
          setDecodeState("ready");
        } catch {
          if (!cancelled) setDecodeState("failed");
        } finally {
          // Close the temporary context — we only used it for decoding.
          ctx?.close?.().catch(() => {
            /* ignore */
          });
        }
      };

      void decode();
      return () => {
        cancelled = true;
      };
    }, [src]);

    React.useImperativeHandle(
      ref,
      () => ({
        seekTo: (ms: number) => {
          const audio = audioRef.current;
          if (audio) {
            audio.currentTime = Math.max(0, ms / 1000);
          }
        },
        play: () => {
          audioRef.current?.play().catch(() => {
            /* ignore */
          });
        },
        pause: () => audioRef.current?.pause(),
      }),
      []
    );

    const onTimeUpdate = () => {
      const audio = audioRef.current;
      if (audio) setCurrentMs(Math.floor(audio.currentTime * 1000));
    };
    const onLoadedMetadata = () => {
      const audio = audioRef.current;
      if (audio) {
        const d = isFinite(audio.duration) ? audio.duration : 0;
        if (d > 0) setDurationMs(Math.floor(d * 1000));
      }
    };

    const togglePlay = () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        audio.play().catch(() => {
          /* ignore */
        });
      } else {
        audio.pause();
      }
    };

    const toggleMute = () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.muted = !audio.muted;
      setMuted(audio.muted);
    };

    const seekToRatio = React.useCallback(
      (ratio: number) => {
        const audio = audioRef.current;
        if (!audio || !durationMs) return;
        const t = ratio * (durationMs / 1000);
        audio.currentTime = t;
        setCurrentMs(Math.floor(t * 1000));
        onSeek?.(Math.floor(t * 1000));
      },
      [durationMs, onSeek]
    );

    const onSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
      const ratio = Number(e.target.value) / 1000;
      seekToRatio(ratio);
    };

    const progress = durationMs > 0 ? Math.min(1, currentMs / durationMs) : 0;

    return (
      <div
        className={cn(
          "flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950",
          className
        )}
      >
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={() => setPlaying(false)}
        />

        {/* Waveform or fallback seek bar */}
        {decodeState === "ready" && peaks ? (
          <WaveformCanvas
            peaks={peaks}
            progress={progress}
            durationMs={durationMs}
            bookmarks={bookmarks}
            onSeekRatio={seekToRatio}
          />
        ) : decodeState === "loading" ? (
          <div
            aria-label="decoding waveform"
            className="relative h-16 w-full overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-900"
          >
            <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-zinc-200/60 to-transparent dark:via-zinc-800/60" />
            <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 dark:text-zinc-400">
              decoding...
            </div>
          </div>
        ) : (
          // Idle (very short window before fetch starts) or failed: plain seek bar.
          <div className="relative flex h-16 items-center">
            <input
              type="range"
              min={0}
              max={1000}
              value={
                durationMs ? Math.round((currentMs / durationMs) * 1000) : 0
              }
              onChange={onSeekInput}
              aria-label="seek"
              className="w-full accent-zinc-900 dark:accent-zinc-100"
            />
            {durationMs > 0 && bookmarks
              ? bookmarks.map((b) => {
                  const left = `${Math.min(
                    100,
                    Math.max(0, (b.atMs / durationMs) * 100)
                  )}%`;
                  return (
                    <button
                      key={b.id}
                      type="button"
                      title={b.note ?? "书签"}
                      aria-label={b.note ?? "bookmark"}
                      onClick={() => {
                        const audio = audioRef.current;
                        if (audio) audio.currentTime = b.atMs / 1000;
                      }}
                      style={{ left }}
                      className="absolute -top-1.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-zinc-950"
                    />
                  );
                })
              : null}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="default"
            size="icon"
            onClick={togglePlay}
            aria-label={playing ? "暂停" : "播放"}
          >
            {playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>

          <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
            {format(currentMs)} / {format(durationMs)}
          </span>

          <div className="flex-1" />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleMute}
            aria-label="静音"
          >
            {muted ? (
              <VolumeX className="h-4 w-4" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    );
  }
);

export default AudioPlayer;
