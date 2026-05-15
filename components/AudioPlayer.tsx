"use client";

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

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

export const AudioPlayer = React.forwardRef<AudioPlayerHandle, AudioPlayerProps>(
  function AudioPlayer({ src, bookmarks, className, onSeek }, ref) {
    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const [playing, setPlaying] = React.useState(false);
    const [currentMs, setCurrentMs] = React.useState(0);
    const [durationMs, setDurationMs] = React.useState(0);
    const [muted, setMuted] = React.useState(false);

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
        setDurationMs(Math.floor(d * 1000));
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

    const onSeekInput = (e: React.ChangeEvent<HTMLInputElement>) => {
      const audio = audioRef.current;
      if (!audio || !durationMs) return;
      const ratio = Number(e.target.value) / 1000;
      const t = ratio * (durationMs / 1000);
      audio.currentTime = t;
      setCurrentMs(Math.floor(t * 1000));
      onSeek?.(Math.floor(t * 1000));
    };

    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950",
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
        <Button
          type="button"
          variant="default"
          size="icon"
          onClick={togglePlay}
          aria-label={playing ? "暂停" : "播放"}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>

        <div className="relative flex flex-1 items-center">
          <input
            type="range"
            min={0}
            max={1000}
            value={durationMs ? Math.round((currentMs / durationMs) * 1000) : 0}
            onChange={onSeekInput}
            aria-label="seek"
            className="w-full accent-zinc-900 dark:accent-zinc-100"
          />
          {/* Bookmark dots */}
          {durationMs > 0 && bookmarks
            ? bookmarks.map((b) => {
                const left = `${Math.min(100, Math.max(0, (b.atMs / durationMs) * 100))}%`;
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

        <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
          {format(currentMs)} / {format(durationMs)}
        </span>

        <Button type="button" variant="ghost" size="icon" onClick={toggleMute} aria-label="静音">
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </Button>
      </div>
    );
  }
);

export default AudioPlayer;
