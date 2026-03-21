import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import type { RawTranscriptEntry } from "./types";
import { LOG_PREFIX } from "./constants";

interface TranscriptTailerEvents {
  "entry:assistant": [entry: RawTranscriptEntry];
  "entry:user": [entry: RawTranscriptEntry];
  "entry:system": [entry: RawTranscriptEntry];
  "entry:progress": [entry: RawTranscriptEntry];
  "entry:custom-title": [entry: RawTranscriptEntry];
  error: [error: Error];
}

const POLL_INTERVAL_MS = 500;

/** Known entry types that we silently skip (metadata, not for Discord output) */
const IGNORED_TYPES = new Set([
  "file-history-snapshot",
  "agent-name",
  "queue-operation",
]);

/**
 * Tails a Claude Code JSONL transcript file and emits parsed entries.
 * Handles files that don't exist yet, partial line writes, and rapid growth.
 */
export class TranscriptTailer extends EventEmitter<TranscriptTailerEvents> {
  private readonly transcriptPath: string;
  private lastOffset: number;
  private lineBuffer = "";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(transcriptPath: string, startOffset = 0) {
    super();
    this.transcriptPath = transcriptPath;
    this.lastOffset = startOffset;
  }

  /** Begin polling the transcript file for new entries */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => this.pollFile(), POLL_INTERVAL_MS);
    console.log(
      `${LOG_PREFIX} Tailer started: ${this.transcriptPath} (offset=${this.lastOffset})`,
    );
  }

  /** Stop polling and clean up */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.lineBuffer = "";
    console.log(`${LOG_PREFIX} Tailer stopped: ${this.transcriptPath}`);
  }

  /** Seek to end of file — used on reconnection to skip already-posted content */
  async seekToEnd(): Promise<void> {
    try {
      const file = Bun.file(this.transcriptPath);
      if (await file.exists()) {
        const stat = fs.statSync(this.transcriptPath);
        this.lastOffset = stat.size;
        this.lineBuffer = "";
        console.log(
          `${LOG_PREFIX} Tailer seeked to end: offset=${this.lastOffset}`,
        );
      }
    } catch {
      // File doesn't exist yet — leave offset at 0
    }
  }

  /** Get current byte offset (for persistence) */
  getOffset(): number {
    return this.lastOffset;
  }

  private async pollFile(): Promise<void> {
    try {
      // Check file existence
      const file = Bun.file(this.transcriptPath);
      if (!(await file.exists())) return;

      // Use fs.statSync for reliable size on Windows
      const currentSize = fs.statSync(this.transcriptPath).size;
      if (currentSize <= this.lastOffset) {
        // Handle file truncation (shouldn't happen, but defensive)
        if (currentSize < this.lastOffset) {
          console.warn(
            `${LOG_PREFIX} Transcript file truncated — resetting offset`,
          );
          this.lastOffset = 0;
          this.lineBuffer = "";
        }
        return;
      }

      // Read new bytes
      const newText = await file
        .slice(this.lastOffset, currentSize)
        .text();
      this.lastOffset = currentSize;

      // Prepend any buffered partial line
      const combined = this.lineBuffer + newText;

      // Split into lines
      const lines = combined.split("\n");

      // If the text doesn't end with \n, the last element is incomplete
      if (!combined.endsWith("\n")) {
        this.lineBuffer = lines.pop() ?? "";
      } else {
        this.lineBuffer = "";
      }

      // Parse complete lines
      for (const line of lines) {
        this.parseLine(line);
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let entry: RawTranscriptEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines — transcript may have partial writes
      return;
    }

    if (!entry.type) return;

    // Skip known metadata entry types
    if (IGNORED_TYPES.has(entry.type)) return;

    switch (entry.type) {
      case "assistant":
        this.emit("entry:assistant", entry);
        break;
      case "user":
        this.emit("entry:user", entry);
        break;
      case "system":
        this.emit("entry:system", entry);
        break;
      case "progress":
        this.emit("entry:progress", entry);
        break;
      case "custom-title":
      case "summary":
        this.emit("entry:custom-title", entry);
        break;
      // Unknown types: silently skip
    }
  }
}
