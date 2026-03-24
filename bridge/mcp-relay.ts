import type { PluginRegistration } from "./types";
import { LOG_PREFIX } from "./constants";

export interface PendingMessage {
  type?: "message" | "permission_verdict";
  message?: string;
  senderId?: string;
  request_id?: string;
  behavior?: string;
}

interface PollResolver {
  resolve: (msg: PendingMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const POLL_TIMEOUT_MS = 30_000;

/**
 * Manages MCP channel plugin registrations and routes Discord messages
 * to the correct Claude Code session via long-polling.
 *
 * Each Claude Code instance with the plugin registers on startup.
 * The plugin then long-polls for incoming Discord messages.
 * When a Discord user sends a message in a session's forum post,
 * the bridge enqueues it here and the plugin picks it up.
 */
export class McpRelay {
  private registrations = new Map<string, PluginRegistration>();
  private messageQueues = new Map<string, PendingMessage[]>();
  private pollResolvers = new Map<string, PollResolver>();

  /** Register a plugin instance for a session */
  handleRegister(body: PluginRegistration): void {
    this.registrations.set(body.sessionId, body);
    if (!this.messageQueues.has(body.sessionId)) {
      this.messageQueues.set(body.sessionId, []);
    }
    console.log(
      `${LOG_PREFIX} Plugin registered: session=${body.sessionId} pid=${body.pid}`,
    );
  }

  /**
   * Long-poll for the next message destined for this session.
   * Returns immediately if a message is queued, otherwise waits up to 30s.
   * Returns null on timeout (caller should retry).
   */
  handlePoll(sessionId: string): Promise<PendingMessage | null> {
    if (!this.registrations.has(sessionId)) {
      return Promise.resolve(null);
    }

    // Check queue first
    const queue = this.messageQueues.get(sessionId);
    if (queue && queue.length > 0) {
      return Promise.resolve(queue.shift()!);
    }

    // Cancel any stale poll for this session
    const existing = this.pollResolvers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve(null);
      this.pollResolvers.delete(sessionId);
    }

    // Wait for a message or timeout
    return new Promise<PendingMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pollResolvers.delete(sessionId);
        resolve(null);
      }, POLL_TIMEOUT_MS);

      this.pollResolvers.set(sessionId, { resolve, timer });
    });
  }

  /**
   * Enqueue a Discord message for a session.
   * If the plugin is currently polling, resolves immediately.
   * Returns false if the session has no registered plugin.
   */
  enqueueMessage(
    sessionId: string,
    message: string,
    senderId: string,
  ): boolean {
    if (!this.registrations.has(sessionId)) return false;

    const pending: PendingMessage = { type: "message", message, senderId };

    // If a poll is waiting, resolve it immediately
    const resolver = this.pollResolvers.get(sessionId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.pollResolvers.delete(sessionId);
      resolver.resolve(pending);
      return true;
    }

    // Otherwise queue it
    const queue = this.messageQueues.get(sessionId) ?? [];
    queue.push(pending);
    this.messageQueues.set(sessionId, queue);
    return true;
  }

  /** Enqueue a permission verdict for a session (from Discord button click) */
  enqueuePermissionVerdict(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
  ): boolean {
    if (!this.registrations.has(sessionId)) return false;

    const pending: PendingMessage = {
      type: "permission_verdict",
      request_id: requestId,
      behavior,
    };

    const resolver = this.pollResolvers.get(sessionId);
    if (resolver) {
      clearTimeout(resolver.timer);
      this.pollResolvers.delete(sessionId);
      resolver.resolve(pending);
      return true;
    }

    const queue = this.messageQueues.get(sessionId) ?? [];
    queue.push(pending);
    this.messageQueues.set(sessionId, queue);
    return true;
  }

  /** Check if a session has a registered channel plugin */
  hasPlugin(sessionId: string): boolean {
    return this.registrations.has(sessionId);
  }

  /** Clean up all state for a session */
  unregister(sessionId: string): void {
    this.registrations.delete(sessionId);
    this.messageQueues.delete(sessionId);

    const resolver = this.pollResolvers.get(sessionId);
    if (resolver) {
      clearTimeout(resolver.timer);
      resolver.resolve(null);
      this.pollResolvers.delete(sessionId);
    }

    console.log(`${LOG_PREFIX} Plugin unregistered: session=${sessionId}`);
  }

  /** Get all registered session IDs */
  getRegisteredSessionIds(): string[] {
    return Array.from(this.registrations.keys());
  }
}
