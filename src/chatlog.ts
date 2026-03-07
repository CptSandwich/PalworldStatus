// Chat log streaming via Docker container logs
//
// Chat log patterns — may need adjustment based on actual Palworld server output.
// Test by watching `docker logs -f <container>` in-game while someone chats globally.
//
// Pattern 1 (observed in newer Palworld builds):
//   LogPalChat: GlobalMessage From [CharacterName] : message text
// Pattern 2 (alternative format):
//   [Chat] CharacterName: message text

import Dockerode from "dockerode";
import { Writable } from "stream";
import { insertChatMessage } from "./db.js";
import type { PalworldContainer } from "./docker.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

// ── Regex patterns ────────────────────────────────────────────────────────────

// NOTE: These patterns are best-guess based on known Palworld log formats.
// Adjust if the server version produces different output.
const CHAT_PATTERNS: RegExp[] = [
  /\[CHAT\] <(.+?)> (.+)/i,                             // [date] [CHAT] <Name> message
  /LogPalChat: GlobalMessage From \[(.+?)\] : (.+)/i,   // LogPalChat: GlobalMessage From [Name] : message
  /\[Chat\] (.+?): (.+)/i,                              // [Chat] Name: message
];

// ── State ─────────────────────────────────────────────────────────────────────

// Keep track of active streams so we can clean up
const activeStreams = new Map<string, NodeJS.ReadableStream>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function processLogLine(containerId: string, line: string) {
  for (const pattern of CHAT_PATTERNS) {
    const m = line.match(pattern);
    if (m) {
      insertChatMessage(containerId, m[1].trim(), m[2].trim());
      return;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start streaming a container's logs in follow mode.
 * Parses each line for global chat messages and inserts them into the DB.
 * Automatically reconnects if the stream ends (e.g. container restart).
 */
export function startChatLogStream(container: PalworldContainer): void {
  const containerId = container.id;
  stopChatLogStream(containerId);

  function connect() {
    const c = docker.getContainer(containerId);

    c.logs(
      { follow: true, stdout: true, stderr: true, tail: 0 },
      (err: Error | null, stream: unknown) => {
        if (err || !stream) {
          setTimeout(connect, 10_000);
          return;
        }

        const readable = stream as NodeJS.ReadableStream;
        activeStreams.set(containerId, readable);

        // Use dockerode's built-in demux helper to strip the 8-byte frame headers
        // and route stdout/stderr to separate Writable streams.
        let lineBuf = "";
        const lineWriter = new Writable({
          write(chunk: Buffer, _enc, cb) {
            lineBuf += chunk.toString("utf8");
            const parts = lineBuf.split("\n");
            lineBuf = parts.pop() ?? "";
            for (const line of parts) {
              const trimmed = line.trim();
              if (trimmed) processLogLine(containerId, trimmed);
            }
            cb();
          },
        });

        // demuxStream splits the multiplexed stream into stdout + stderr
        (docker as unknown as { modem: { demuxStream: (s: unknown, out: unknown, err: unknown) => void } })
          .modem.demuxStream(stream, lineWriter, null);

        readable.on("error", () => {
          activeStreams.delete(containerId);
          setTimeout(connect, 10_000);
        });

        readable.on("end", () => {
          activeStreams.delete(containerId);
          setTimeout(connect, 10_000);
        });
      }
    );
  }

  connect();
}

/** Stop the log stream for a container (e.g. when it is removed). */
export function stopChatLogStream(containerId: string): void {
  const stream = activeStreams.get(containerId);
  if (stream) {
    try {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    } catch { /* ignore */ }
    activeStreams.delete(containerId);
  }
}

/**
 * Initialise chat log streaming for all currently running containers.
 * Call once at startup after discovering containers.
 */
export function initChatLogStreams(containers: PalworldContainer[]): void {
  const running = containers.filter((c) => c.status === "running");
  for (const container of running) {
    startChatLogStream(container);
  }
  if (running.length > 0) {
    console.log(`[chatlog] Streaming logs for ${running.length} container(s)`);
  }
}
