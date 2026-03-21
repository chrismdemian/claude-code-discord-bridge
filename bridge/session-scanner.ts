import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as fs from "node:fs";
import * as chokidar from "chokidar";
import { SESSIONS_DIR, PROJECTS_DIR, LOG_PREFIX } from "./constants";

export interface SessionInfo {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: string;
  transcriptPath: string;
}

interface SessionScannerEvents {
  "session:discovered": [session: SessionInfo];
  "session:ended": [session: SessionInfo];
  "session:updated": [session: SessionInfo];
}

/**
 * Encode a working directory path the way Claude Code does for project directories.
 * C:\Users\chris\Projects\foo → C--Users-chris-Projects-foo
 */
export function encodeCwdPath(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/[:\/.]/g, "-");
}

/** Resolve the transcript JSONL path for a session */
export function findTranscriptPath(cwd: string, sessionId: string): string {
  const encodedDir = encodeCwdPath(cwd);
  return path.join(PROJECTS_DIR, encodedDir, `${sessionId}.jsonl`);
}

export class SessionScanner extends EventEmitter<SessionScannerEvents> {
  private watcher: ReturnType<typeof chokidar.watch> | null = null;
  private validateInterval: ReturnType<typeof setInterval> | null = null;
  private sessions = new Map<string, SessionInfo>();

  /** Start watching the sessions directory */
  start(): void {
    // Ensure sessions directory exists
    if (!fs.existsSync(SESSIONS_DIR)) {
      console.log(`${LOG_PREFIX} Creating sessions dir: ${SESSIONS_DIR}`);
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    }

    this.watcher = chokidar.watch(SESSIONS_DIR, {
      ignoreInitial: false,
      depth: 0,
    });

    this.watcher.on("add", (filePath: string) => this.handleAdd(filePath));
    this.watcher.on("unlink", (filePath: string) => this.handleUnlink(filePath));
    this.watcher.on("change", (filePath: string) => this.handleChange(filePath));
    this.watcher.on("error", (err: unknown) => {
      console.error(`${LOG_PREFIX} Session scanner error:`, err);
    });

    // Periodic validation to catch sessions that disappeared without triggering unlink
    this.validateInterval = setInterval(() => this.validateSessions(), 30_000);

    console.log(`${LOG_PREFIX} Session scanner watching: ${SESSIONS_DIR}`);
  }

  /** Stop watching */
  async stop(): Promise<void> {
    if (this.validateInterval) {
      clearInterval(this.validateInterval);
      this.validateInterval = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Get all currently tracked sessions */
  getActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  private async handleAdd(filePath: string): Promise<void> {
    if (!filePath.endsWith(".json")) return;

    // Dedup: chokidar on Windows can fire multiple add events for the same file
    if (this.sessions.has(filePath)) return;

    const session = await this.parseSessionFile(filePath);
    if (!session) return;

    this.sessions.set(filePath, session);
    console.log(
      `${LOG_PREFIX} Session discovered: PID=${session.pid}, ID=${session.sessionId}`,
    );
    this.emit("session:discovered", session);
  }

  private handleUnlink(filePath: string): void {
    if (!filePath.endsWith(".json")) return;

    const session = this.sessions.get(filePath);
    if (!session) return;

    this.sessions.delete(filePath);
    console.log(
      `${LOG_PREFIX} Session ended: PID=${session.pid}, ID=${session.sessionId}`,
    );
    this.emit("session:ended", session);
  }

  private async handleChange(filePath: string): Promise<void> {
    if (!filePath.endsWith(".json")) return;

    const oldSession = this.sessions.get(filePath);
    const newSession = await this.parseSessionFile(filePath);
    if (!newSession) return;

    this.sessions.set(filePath, newSession);

    if (oldSession && oldSession.sessionId !== newSession.sessionId) {
      // Session ID changed (e.g. /clear) — treat as end + new start
      console.log(
        `${LOG_PREFIX} Session replaced: ${oldSession.sessionId} → ${newSession.sessionId}`,
      );
      this.emit("session:ended", oldSession);
      this.emit("session:discovered", newSession);
    } else {
      this.emit("session:updated", newSession);
    }
  }

  /** Check all tracked sessions still have their PID files */
  private validateSessions(): void {
    for (const [filePath, session] of this.sessions) {
      if (!fs.existsSync(filePath)) {
        this.sessions.delete(filePath);
        console.log(
          `${LOG_PREFIX} Session file disappeared (periodic check): PID=${session.pid}, ID=${session.sessionId}`,
        );
        this.emit("session:ended", session);
      }
    }
  }

  private async parseSessionFile(
    filePath: string,
  ): Promise<SessionInfo | null> {
    // Retry to handle partially-written files
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = Bun.file(filePath);
        if (!(await file.exists())) return null;

        const raw = await file.json();

        if (!raw.pid || !raw.sessionId || !raw.cwd) {
          console.warn(
            `${LOG_PREFIX} Invalid session file (missing fields): ${filePath}`,
          );
          return null;
        }

        const transcriptPath = findTranscriptPath(raw.cwd, raw.sessionId);

        return {
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          startedAt: String(raw.startedAt),
          transcriptPath,
        };
      } catch {
        if (attempt < 2) await Bun.sleep(100);
      }
    }
    console.error(
      `${LOG_PREFIX} Failed to parse session file after retries: ${filePath}`,
    );
    return null;
  }
}
