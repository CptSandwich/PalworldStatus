// Chat log streaming and player pre-population via Docker container logs
//
// Chat log patterns — may need adjustment based on actual Palworld server output.
// Test by watching `docker logs -f <container>` in-game while someone chats globally.
//
// Pattern 1 (observed in newer Palworld builds):
//   LogPalChat: GlobalMessage From [CharacterName] : message text
// Pattern 2 (alternative format):
//   [Chat] CharacterName: message text
//
// Player join patterns (for startup pre-population):
//   BP_PalGameMode_C::PlayerJoined ...SteamId=<17-digit-id>
//   LogGameMode: PlayerConnected: <17-digit-steamid>

import Dockerode from "dockerode";
import { Writable } from "stream";
import {
  insertChatMessage,
  upsertPlayer,
} from "./db.js";
import type { PalworldContainer } from "./docker.js";

const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

// ── Regex patterns ────────────────────────────────────────────────────────────

// NOTE: These patterns are best-guess based on known Palworld log formats.
// Adjust if the server version produces different output.
const CHAT_PATTERNS: RegExp[] = [
  /LogPalChat: GlobalMessage From \[(.+?)\] : (.+)/i,
  /\[Chat\] (.+?): (.+)/i,
];

// Steam IDs are 17-digit numbers
const JOIN_STEAM_PATTERN = /(\d{17})/g;

// ── State ─────────────────────────────────────────────────────────────────────

// Keep track of active streams so we can clean up
const activeStreams = new Map<string, NodeJS.ReadableStream>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a Docker multiplexed log buffer (non-streaming, static response).
 * Docker prefixes each log line with an 8-byte header:
 *   [stream_type(1), 0, 0, 0, size_BE(4)]
 * Returns plain text lines.
 */
function parseMuxedBuffer(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;

  while (offset + 8 <= buf.length) {
    const frameSize = buf.readUInt32BE(offset + 4);
    if (frameSize === 0) {
      offset += 8;
      continue;
    }
    const end = offset + 8 + frameSize;
    if (end > buf.length) break;

    const frameText = buf.slice(offset + 8, end).toString("utf8");
    for (const line of frameText.split("\n")) {
      const t = line.trim();
      if (t) lines.push(t);
    }
    offset = end;
  }

  return lines;
}

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
 * Scan the last 10,000 lines of a container's logs for player join events
 * and pre-populate the known_players table. Called once at startup per container.
 *
 * NOTE: Steam IDs in logs are heuristically matched as 17-digit numbers.
 * This may produce false positives for other numeric sequences of the same length.
 * The pattern should be refined against actual Palworld log output.
 */
export async function scanLogsForPlayers(container: PalworldContainer): Promise<void> {
  try {
    const c = docker.getContainer(container.id);

    const buf = await new Promise<Buffer>((resolve, reject) => {
      c.logs(
        { stdout: true, stderr: true, tail: 10000 },
        (err: Error | null, result: unknown) => {
          if (err) reject(err);
          else resolve(result as Buffer);
        }
      );
    });

    const lines = parseMuxedBuffer(buf);
    const foundIds = new Set<string>();

    for (const line of lines) {
      // Look for 17-digit Steam IDs in join-related lines
      if (
        /joined|connected|player/i.test(line) &&
        !/disconnect|left|leave/i.test(line)
      ) {
        const matches = [...line.matchAll(JOIN_STEAM_PATTERN)];
        for (const m of matches) {
          foundIds.add(m[1]);
        }
      }
    }

    if (foundIds.size > 0) {
      for (const steamId of foundIds) {
        upsertPlayer(steamId, `Player ${steamId.slice(-4)}`, container.displayName);
      }
      console.log(
        `[chatlog] Pre-populated ${foundIds.size} player(s) from ${container.displayName} logs`
      );
    }
  } catch {
    // Non-critical — container may have no logs or socket error
  }
}

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
 * Scans existing logs first for player pre-population, then starts streaming.
 * Call once at startup after discovering containers.
 */
export async function initChatLogStreams(
  containers: PalworldContainer[]
): Promise<void> {
  const running = containers.filter((c) => c.status === "running");

  for (const container of running) {
    await scanLogsForPlayers(container);
    startChatLogStream(container);
  }

  if (running.length > 0) {
    console.log(`[chatlog] Streaming logs for ${running.length} container(s)`);
  }
}
