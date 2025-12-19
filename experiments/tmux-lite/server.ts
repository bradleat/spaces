#!/usr/bin/env bun
/**
 * tmux-lite server - manages all sessions in a single process
 */

import { unlinkSync } from "fs";
import {
  ROUTER_SOCKET,
  type Command,
  type Response,
  type Session,
  type SessionCtrl,
  encode,
  isCtrlMagic,
  decode,
  ctrlMsgLen,
} from "./protocol";

// Clean up
try { unlinkSync(ROUTER_SOCKET); } catch {}

interface SessionData {
  info: Session;
  terminal: Bun.Terminal;
  proc: Bun.Subprocess;
  client: any;
  scrollback: Buffer;
  ctrlBuffer: Buffer; // For buffering partial control messages from client
}

const sessions = new Map<string, SessionData>();

let sessionCounter = 0;

function genId(): string {
  return String(sessionCounter++);
}

// Alternate screen sequences (different terminals/apps use different ones)
const ALT_SCREEN_ON_SEQS = [
  Buffer.from("\x1b[?1049h"),  // xterm - save cursor + switch + clear
  Buffer.from("\x1b[?1047h"),  // xterm - switch to alt screen
  Buffer.from("\x1b[?47h"),    // older terminals
];
const ALT_SCREEN_OFF_SEQS = [
  Buffer.from("\x1b[?1049l"),  // xterm - restore
  Buffer.from("\x1b[?1047l"),
  Buffer.from("\x1b[?47l"),
];

// Cursor positioning pattern: ESC [ <row> ; <col> H
// TUI apps use this constantly to draw their UI
const CURSOR_POS_REGEX = /\x1b\[(\d+);(\d+)H/g;

// Shell prompt patterns that indicate we're back in a normal shell
const SHELL_PROMPT_PATTERNS = [
  Buffer.from("$ "),           // bash/zsh prompt
  Buffer.from("# "),           // root prompt
  Buffer.from("% "),           // zsh prompt
];

function containsAny(data: Buffer, patterns: Buffer[]): boolean {
  return patterns.some(p => data.includes(p));
}

// Reset sequence for clean reattach (when not in alternate screen)
const TERM_RESET = Buffer.from(
  "\x1b[?1049l" +  // ensure we're out of alt screen
  "\x1b[!p" +      // soft reset
  "\x1b[?25h" +    // show cursor
  "\x1bc"          // full reset (RIS)
);

function createSession(name: string | undefined, cwd: string): Session {
  const id = genId();
  const sessionName = name || `session-${id}`;
  const socketPath = `/tmp/tmux-lite-${id}.sock`;

  let scrollback = Buffer.alloc(0);
  let inAlternateScreen = false;  // Track if we're in alternate screen mode
  let inFullScreenApp = false;    // Track if a full-screen app (like claude) is running
  let client: any = null;
  let ctrlBuffer = Buffer.alloc(0);

  const terminal = new Bun.Terminal({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    data(term, data) {
      // Check for alternate screen transitions
      if (containsAny(data, ALT_SCREEN_ON_SEQS)) {
        if (!inAlternateScreen) {
          console.log(`[${sessionName}] -> alt screen ON`);
        }
        inAlternateScreen = true;
      }
      if (containsAny(data, ALT_SCREEN_OFF_SEQS)) {
        if (inAlternateScreen) {
          console.log(`[${sessionName}] -> alt screen OFF`);
        }
        inAlternateScreen = false;
      }

      // Check for TUI app via cursor positioning to top of screen
      // Normal shells only write at the bottom; TUIs position cursor everywhere
      if (!inFullScreenApp && !inAlternateScreen) {
        const str = data.toString();
        const matches = [...str.matchAll(CURSOR_POS_REGEX)];
        for (const match of matches) {
          const row = parseInt(match[1], 10);
          // If cursor is positioned in top half of screen, likely a TUI
          if (row < 10) {
            console.log(`[${sessionName}] -> TUI detected (cursor row ${row})`);
            inFullScreenApp = true;
            break;
          }
        }
      }

      // Check for shell prompt (indicates full-screen app exited)
      if (inFullScreenApp && containsAny(data, SHELL_PROMPT_PATTERNS)) {
        console.log(`[${sessionName}] -> shell prompt, exiting full screen mode`);
        inFullScreenApp = false;
      }

      // Only add to scrollback if NOT in alternate screen or full-screen app
      const skipScrollback = inAlternateScreen || inFullScreenApp;
      if (!skipScrollback) {
        scrollback = Buffer.concat([scrollback, data]);
        if (scrollback.length > 100 * 1024) {
          scrollback = scrollback.subarray(-100 * 1024);
        }
      }

      // Update session reference
      const session = sessions.get(id);
      if (session) {
        session.scrollback = scrollback;
        // Send to client (always, even alternate screen content)
        if (session.client) {
          session.client.write(data);
        }
      }
    }
  });

  const shell = process.env.SHELL || "/bin/bash";
  const proc = Bun.spawn([shell], {
    terminal,
    cwd,
    env: { ...process.env, TMUX_LITE: id },
  });

  proc.exited.then(code => {
    const session = sessions.get(id);
    if (session?.client) {
      session.client.write(encode({ type: "exited", code }));
      session.client.end();
    }
    try { unlinkSync(socketPath); } catch {}
    sessions.delete(id);
    console.log(`[${sessionName}] exited (${code})`);
  });

  const info: Session = {
    id,
    name: sessionName,
    socketPath,
    pid: proc.pid,
    attached: false,
    cwd,
    createdAt: Date.now(),
  };

  // Create session socket
  Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        const session = sessions.get(id);
        if (!session) return socket.end();

        // Kick existing client
        if (session.client) {
          session.client.write(encode({ type: "kicked" }));
          session.client.end();
        }

        session.client = socket;
        session.info.attached = true;
        session.ctrlBuffer = Buffer.alloc(0);
        const inApp = inAlternateScreen || inFullScreenApp;
        console.log(`[${sessionName}] attached (inApp: ${inApp})`);

        if (inApp) {
          // In vim/claude/etc - just trigger a resize to redraw
          // Don't send scrollback or reset
          socket.write(encode({ type: "attached" }));
        } else {
          // Normal shell - clear screen, show recent shell output
          socket.write(Buffer.from("\x1bc\x1b[2J\x1b[H")); // RIS + clear + home

          if (session.scrollback.length > 0) {
            const scrollStr = session.scrollback.toString();

            // Find the last "reset point" - clear screen, RIS, or alt screen exit
            // This helps skip over any TUI content that wasn't detected
            const resetPatterns = [
              /\x1bc/g,           // RIS (reset)
              /\x1b\[2J/g,        // Clear screen
              /\x1b\[\?1049l/g,   // Alt screen off
              /\x1b\[\?1047l/g,   // Alt screen off variant
              /\x1b\[\?47l/g,     // Alt screen off old
            ];

            let lastResetIdx = -1;
            for (const pattern of resetPatterns) {
              let match;
              while ((match = pattern.exec(scrollStr)) !== null) {
                if (match.index > lastResetIdx) {
                  lastResetIdx = match.index + match[0].length;
                }
              }
            }

            // Get content after last reset, or last 4KB if no reset found
            let content: string;
            if (lastResetIdx > 0) {
              content = scrollStr.substring(lastResetIdx);
            } else {
              content = scrollStr.substring(Math.max(0, scrollStr.length - 4096));
            }

            // Count cursor positioning - if too many, it's TUI garbage
            const cursorPosCount = (content.match(/\x1b\[\d+;\d+H/g) || []).length;
            if (cursorPosCount > 20) {
              // Too much cursor positioning - likely TUI output, skip it
              console.log(`[${sessionName}] skipping scrollback (${cursorPosCount} cursor positions)`);
            } else {
              // Clean up escape sequences and send
              const cleaned = content
                .replace(/\x1b\[\d+;\d+H/g, '')  // cursor positioning
                .replace(/\x1b\[\d+[ABCD]/g, '') // cursor movement
                .replace(/\x1b\[2J/g, '')        // clear screen
                .replace(/\x1b\[H/g, '')         // cursor home
                .replace(/\x1b\[\?25[hl]/g, ''); // cursor show/hide

              // Find a good starting point (after a newline)
              const newlineIdx = cleaned.indexOf('\n');
              const toSend = (newlineIdx > 0 && newlineIdx < 100)
                ? cleaned.substring(newlineIdx + 1)
                : cleaned;

              if (toSend.trim().length > 0) {
                socket.write(Buffer.from(toSend));
              }
            }
          }
          socket.write(encode({ type: "attached" }));
        }
      },

      data(socket, data) {
        const session = sessions.get(id);
        if (!session) return;

        let buf = Buffer.from(data);

        // Prepend any buffered data
        if (session.ctrlBuffer.length > 0) {
          buf = Buffer.concat([session.ctrlBuffer, buf]);
          session.ctrlBuffer = Buffer.alloc(0);
        }

        let offset = 0;
        while (offset < buf.length) {
          if (isCtrlMagic(buf, offset)) {
            const len = ctrlMsgLen(buf, offset);
            if (len < 0 || offset + len > buf.length) {
              // Incomplete, buffer it
              session.ctrlBuffer = buf.subarray(offset);
              break;
            }

            const ctrl = decode(buf, offset) as SessionCtrl;
            if (ctrl.type === "resize") {
              try {
                terminal.resize(ctrl.cols, ctrl.rows);
                // Send SIGWINCH to process group so children (vim, etc.) get it
                process.kill(-proc.pid, "SIGWINCH");
              } catch {
                try { process.kill(proc.pid, "SIGWINCH"); } catch {}
              }
            } else if (ctrl.type === "detach") {
              session.client = null;
              session.info.attached = false;
              socket.end();
              console.log(`[${sessionName}] detached`);
            }
            offset += len;
          } else {
            // Raw input byte - write to PTY
            // Find next control magic or end
            let end = offset + 1;
            while (end < buf.length && !isCtrlMagic(buf, end)) {
              end++;
            }
            session.terminal.write(buf.subarray(offset, end));
            offset = end;
          }
        }
      },

      close(socket) {
        const session = sessions.get(id);
        if (session && session.client === socket) {
          session.client = null;
          session.info.attached = false;
          console.log(`[${sessionName}] disconnected`);
        }
      }
    }
  });

  sessions.set(id, {
    info,
    terminal,
    proc,
    client: null,
    scrollback: Buffer.alloc(0),
    ctrlBuffer: Buffer.alloc(0)
  });

  console.log(`[${sessionName}] created (pid ${proc.pid})`);
  return info;
}

// Router server
Bun.listen({
  unix: ROUTER_SOCKET,
  socket: {
    data(socket, data) {
      const cmd: Command = JSON.parse(data.toString());
      let res: Response;

      switch (cmd.type) {
        case "list":
          res = {
            type: "sessions",
            sessions: Array.from(sessions.values()).map(s => s.info)
          };
          break;

        case "new":
          const session = createSession(cmd.name, cmd.cwd);
          res = { type: "session", session };
          break;

        case "attach": {
          const s = sessions.get(cmd.id);
          if (!s) {
            res = { type: "error", message: `Session ${cmd.id} not found` };
          } else if (s.info.attached && !cmd.force) {
            res = { type: "already-attached", session: s.info };
          } else {
            res = { type: "session", session: s.info };
          }
          break;
        }

        case "kill": {
          const s = sessions.get(cmd.id);
          if (!s) {
            res = { type: "error", message: `Session ${cmd.id} not found` };
          } else {
            s.proc.kill();
            res = { type: "ok" };
          }
          break;
        }

        case "kill-server":
          console.log("Shutting down...");
          for (const [id, s] of sessions) {
            s.proc.kill();
          }
          res = { type: "ok" };
          socket.write(JSON.stringify(res));
          setTimeout(() => process.exit(0), 100);
          return;

        default:
          res = { type: "error", message: "Unknown command" };
      }

      socket.write(JSON.stringify(res));
    }
  }
});

console.log("tmux-lite server running");
console.log(`Socket: ${ROUTER_SOCKET}\n`);
