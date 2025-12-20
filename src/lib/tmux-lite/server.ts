#!/usr/bin/env bun
// @ts-nocheck - Uses Bun-specific APIs (Bun.Terminal, etc.)
/**
 * tmux-lite server - manages all sessions in a single process
 * Uses xterm-headless for proper terminal state tracking
 */

import { unlinkSync } from "fs";
import { Terminal as XTerminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import {
  ROUTER_SOCKET,
  type Command,
  type Response,
  type Session,
  type SessionCtrl,
  type InboxItem,
  encode,
  isCtrlMagic,
  decode,
  ctrlMsgLen,
} from "./protocol";

// Clean up
try { unlinkSync(ROUTER_SOCKET); } catch {}

interface SessionData {
  info: Session;
  ptyTerminal: Bun.Terminal;
  xterm: XTerminal;
  serialize: SerializeAddon;
  proc: Bun.Subprocess;
  client: any;
  ctrlBuffer: Buffer;
  pendingWrites: number;  // Track pending xterm writes
  attaching: boolean;
  attachBuffer: Buffer[];
  processTitle: string;   // Title set by running process (via OSC 0)
  lastInteraction: number;  // Timestamp of last user input
  lastDetached: number;  // Timestamp of last detach (for grace period)
  lastAttached: number;  // Timestamp of last attach (for grace period)
}

const sessions = new Map<string, SessionData>();
const inbox: InboxItem[] = [];

// How long after last interaction before we consider the user "inactive"
const INTERACTION_TIMEOUT_MS = 30000; // 30 seconds
// Grace period after attach/detach - don't notify immediately
const ATTACH_GRACE_MS = 5000; // 5 seconds after attach
const DETACH_GRACE_MS = 5000; // 5 seconds after detach

// Check if user is actively using the session or recently attached/detached
// Returns true if we should SUPPRESS notifications
function isActivelyUsing(session: SessionData | undefined): boolean {
  if (!session) return false;

  const now = Date.now();

  // If recently detached, still suppress notifications (grace period)
  if (session.lastDetached > 0) {
    const timeSinceDetach = now - session.lastDetached;
    if (timeSinceDetach < DETACH_GRACE_MS) {
      return true; // Suppress - just detached
    }
  }

  // If not attached, don't suppress (unless in grace period above)
  if (!session.info.attached) return false;

  // If recently attached, suppress notifications (startup grace period)
  if (session.lastAttached > 0) {
    const timeSinceAttach = now - session.lastAttached;
    if (timeSinceAttach < ATTACH_GRACE_MS) {
      return true; // Suppress - just attached
    }
  }

  // If attached but never interacted AND past the attach grace period, don't suppress
  if (session.lastInteraction === 0) return false;

  // If attached and recently interacted, suppress
  const timeSinceInteraction = now - session.lastInteraction;
  return timeSinceInteraction < INTERACTION_TIMEOUT_MS;
}

let sessionCounter = 0;
let inboxCounter = 0;

function genId(): string {
  return String(sessionCounter++);
}

function genInboxId(): string {
  return String(inboxCounter++);
}

function addInboxItem(item: Omit<InboxItem, 'id' | 'read'>): void {
  inbox.push({
    ...item,
    id: genInboxId(),
    read: false,
  });
  console.log(`[inbox] ${item.type}: ${item.sessionName} - ${item.context.substring(0, 50)}`);

  // Update titles for all attached sessions to show new inbox count
  broadcastTitleUpdate();
}

function getLastLines(xterm: XTerminal, count: number): string {
  const buffer = xterm.buffer.active;
  const lines: string[] = [];
  const startRow = Math.max(0, buffer.cursorY - count + 1);

  for (let i = startRow; i <= buffer.cursorY; i++) {
    const line = buffer.getLine(i)?.translateToString(true);
    if (line) lines.push(line);
  }

  return lines.join('\n').trim();
}

function getCurrentLine(xterm: XTerminal): string {
  const buffer = xterm.buffer.active;
  return buffer.getLine(buffer.cursorY)?.translateToString(true)?.trim() || '';
}

function getUnreadInboxCount(): number {
  return inbox.filter(i => !i.read).length;
}

function buildTitle(sessionName: string, processTitle?: string): string {
  const unread = getUnreadInboxCount();
  let title = `tl: ${sessionName}`;

  if (processTitle) {
    title += ` | ${processTitle}`;
  }

  if (unread > 0) {
    title += ` (${unread} 🔔)`;
  }

  return title;
}

function sendTitle(socket: any, sessionName: string, processTitle?: string): void {
  const title = buildTitle(sessionName, processTitle);
  // OSC 0 sets both icon and window title
  socket.write(Buffer.from(`\x1b]0;${title}\x07`));
}

function broadcastTitleUpdate(): void {
  // Update title for all attached sessions
  for (const [id, session] of sessions) {
    if (session.client) {
      sendTitle(session.client, session.info.name, session.processTitle);
    }
  }
}

// RIS (Reset to Initial State) - the nuclear option that resets everything
const TERM_RESET = Buffer.from("\x1bc");

function createSession(name: string | undefined, cwd: string): Session {
  const id = genId();
  const sessionName = name || `session-${id}`;
  const socketPath = `/tmp/tmux-lite-${id}.sock`;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Create xterm-headless for proper terminal state tracking
  const xterm = new XTerminal({
    cols,
    rows,
    scrollback: 1000,
    allowProposedApi: true,
  });

  const serialize = new SerializeAddon();
  xterm.loadAddon(serialize);

  // Track bells for inbox notifications (with debounce)
  let lastBellTime = 0;
  xterm.onBell(() => {
    const session = sessions.get(id);
    // Don't notify if user is actively using the session
    if (isActivelyUsing(session)) return;

    const now = Date.now();
    // Debounce: ignore bells within 500ms of each other
    if (now - lastBellTime < 500) return;
    lastBellTime = now;

    // Get last few lines for context (not just current line)
    const context = getLastLines(xterm, 3) || getCurrentLine(xterm) || '(bell)';
    addInboxItem({
      sessionId: id,
      sessionName,
      type: 'bell',
      timestamp: now,
      context,
      processTitle: session?.processTitle,
    });
  });

  // Track title changes from running processes
  let processTitle = '';
  let lastTitleNotification = 0;
  xterm.onTitleChange((title) => {
    console.log(`[${sessionName}] title changed: "${title}"`);
    const previousTitle = processTitle;
    processTitle = title;
    const session = sessions.get(id);
    if (session) {
      session.processTitle = title;
      // Update client's terminal title if attached
      if (session.client) {
        sendTitle(session.client, sessionName, title);
      }

      // Create inbox notification for ANY title change when not actively using
      // This helps track when background processes change state
      const now = Date.now();
      if (!isActivelyUsing(session) && title && title !== previousTitle) {
        // Debounce: don't notify more than once per 3 seconds
        if (now - lastTitleNotification > 3000) {
          lastTitleNotification = now;
          addInboxItem({
            sessionId: id,
            sessionName,
            type: 'title',
            timestamp: now,
            context: title,
            processTitle: title,
          });
          console.log(`[${sessionName}] title change: ${previousTitle} -> ${title}`);
        }
      }
    }
  });

  let client: any = null;
  let ctrlBuffer = Buffer.alloc(0);

  // Idle detection: notify when background session goes quiet after activity
  let lastOutputTime = 0;
  let outputSinceIdle = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const IDLE_THRESHOLD_MS = 10000; // 10 seconds of quiet after output
  const MIN_OUTPUT_FOR_IDLE = 500; // Need at least 500 bytes of output to consider "activity"

  const checkIdle = () => {
    const session = sessions.get(id);
    // Only notify if: not actively using, had significant output, and now idle
    if (!isActivelyUsing(session) && outputSinceIdle >= MIN_OUTPUT_FOR_IDLE) {
      const context = getLastLines(xterm, 3) || '(idle)';
      addInboxItem({
        sessionId: id,
        sessionName,
        type: 'idle',
        timestamp: Date.now(),
        context,
        processTitle: session?.processTitle || processTitle,
      });
      console.log(`[${sessionName}] idle notification after ${outputSinceIdle} bytes output`);
    }
    outputSinceIdle = 0;
  };

  // OSC patterns for notifications
  // Our custom exit code: ESC ] 777 ; exit : <code> BEL
  const OSC_EXIT_PATTERN = /\x1b\]777;exit:(-?\d+)\x07/g;
  // iTerm2/Growl notification: ESC ] 9 ; message BEL
  const OSC_9_PATTERN = /\x1b\]9;([^\x07]*)\x07/g;
  // Kitty notification: ESC ] 99 ; i=id:d=0; body BEL (simplified)
  const OSC_99_PATTERN = /\x1b\]99;[^;]*;([^\x07]*)\x07/g;
  // rxvt notification: ESC ] 777 ; notify ; title ; body BEL
  const OSC_777_NOTIFY_PATTERN = /\x1b\]777;notify;([^;]*);([^\x07]*)\x07/g;
  // Semantic shell integration (Ghostty, iTerm2, etc.)
  // OSC 133 ; D [; exitcode] - Command finished (D = done)
  const OSC_133_DONE_PATTERN = /\x1b\]133;D(?:;(\d+))?\x07/g;
  // Track if a command is running (for OSC 133 A = prompt start, C = command start)
  let commandRunning = false;
  const OSC_133_CMD_START = /\x1b\]133;C\x07/g;

  const ptyTerminal = new Bun.Terminal({
    cols,
    rows,
    data(term, data) {
      // Track output for idle detection
      lastOutputTime = Date.now();
      outputSinceIdle += data.length;

      // Reset idle timer
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(checkIdle, IDLE_THRESHOLD_MS);

      const session = sessions.get(id);
      if (!session) return;

      const str = data.toString();
      const now = Date.now();

      // Only create inbox notifications if user is not actively using the session
      const activelyUsing = session.attaching || isActivelyUsing(session);
      const currentProcessTitle = session.processTitle || processTitle;

      // Check for custom OSC exit code sequence (only notify if not actively using)
      if (!activelyUsing) {
        const exitMatches = [...str.matchAll(OSC_EXIT_PATTERN)];
        for (const match of exitMatches) {
          const exitCode = parseInt(match[1], 10);
          const context = getCurrentLine(xterm) || `Exit code: ${exitCode}`;
          addInboxItem({
            sessionId: id,
            sessionName,
            type: 'exit',
            timestamp: now,
            exitCode,
            context,
            processTitle: currentProcessTitle,
          });
          console.log(`[${sessionName}] command exit: ${exitCode}`);
        }

        // Check for iTerm2/Growl notification (OSC 9)
        const osc9Matches = [...str.matchAll(OSC_9_PATTERN)];
        for (const match of osc9Matches) {
          const message = match[1];
          if (message) {
            addInboxItem({
              sessionId: id,
              sessionName,
              type: 'bell',
              timestamp: now,
              context: message,
              processTitle: currentProcessTitle,
            });
            console.log(`[${sessionName}] OSC 9 notification: ${message}`);
          }
        }

        // Check for Kitty notification (OSC 99)
        const osc99Matches = [...str.matchAll(OSC_99_PATTERN)];
        for (const match of osc99Matches) {
          const body = match[1];
          if (body) {
            addInboxItem({
              sessionId: id,
              sessionName,
              type: 'bell',
              timestamp: now,
              context: body,
              processTitle: currentProcessTitle,
            });
            console.log(`[${sessionName}] OSC 99 notification: ${body}`);
          }
        }

        // Check for rxvt notification (OSC 777 notify)
        const osc777Matches = [...str.matchAll(OSC_777_NOTIFY_PATTERN)];
        for (const match of osc777Matches) {
          const title = match[1];
          const body = match[2];
          addInboxItem({
            sessionId: id,
            sessionName,
            type: 'bell',
            timestamp: now,
            context: body || title || 'Notification',
            processTitle: currentProcessTitle,
          });
          console.log(`[${sessionName}] OSC 777 notification: ${title} - ${body}`);
        }
      }

      // Check for semantic shell integration (OSC 133)
      // Command start
      if (OSC_133_CMD_START.test(str)) {
        commandRunning = true;
        OSC_133_CMD_START.lastIndex = 0; // Reset regex state
      }

      // Command done - only notify if not actively using and command was running
      const osc133DoneMatches = [...str.matchAll(OSC_133_DONE_PATTERN)];
      for (const match of osc133DoneMatches) {
        const exitCode = match[1] ? parseInt(match[1], 10) : 0;
        // Only notify for background sessions with non-zero exit or if command was tracked
        if (!activelyUsing && (exitCode !== 0 || commandRunning)) {
          const context = getLastLines(xterm, 2) || `Command finished (exit ${exitCode})`;
          addInboxItem({
            sessionId: id,
            sessionName,
            type: exitCode !== 0 ? 'exit' : 'idle',
            timestamp: now,
            exitCode: exitCode !== 0 ? exitCode : undefined,
            context,
            processTitle: currentProcessTitle,
          });
          console.log(`[${sessionName}] OSC 133 command done: exit ${exitCode}`);
        }
        commandRunning = false;
      }

      // Pass original data through unchanged to preserve all escape sequences
      // Our custom OSC 777 exit sequences are harmless - terminals ignore unknown OSC
      // Converting to string and back was corrupting cursor movement/screen control sequences

      if (session.attaching) {
        session.attachBuffer.push(Buffer.from(data));
        return;
      }

      // Feed data to xterm-headless for state tracking
      session.pendingWrites++;
      xterm.write(data, () => {
        session.pendingWrites--;
      });

      // Send to client
      if (session.client) {
        session.client.write(data);
      }
    }
  });

  const shell = process.env.SHELL || "/bin/bash";

  // Shell integration: report non-zero exit codes via OSC 777
  // This creates inbox notifications for failed commands
  const exitReporter = '__tl_report() { local e=$?; [[ $e -ne 0 ]] && printf "\\033]777;exit:%d\\007" "$e"; return $e; }';

  // Build environment with shell integration
  const shellEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TMUX_LITE: id,
  };

  // Add PROMPT_COMMAND for bash
  if (shell.endsWith('/bash') || shell.endsWith('/sh')) {
    const existingPrompt = process.env.PROMPT_COMMAND || '';
    shellEnv.PROMPT_COMMAND = `${exitReporter}; __tl_report${existingPrompt ? '; ' + existingPrompt : ''}`;
  }

  const proc = Bun.spawn([shell], {
    terminal: ptyTerminal,
    cwd,
    env: shellEnv,
  });

  proc.exited.then(code => {
    const session = sessions.get(id);

    // Capture last lines for inbox before disposing xterm
    const context = getLastLines(xterm, 3);
    addInboxItem({
      sessionId: id,
      sessionName,
      type: 'exit',
      timestamp: Date.now(),
      exitCode: code,
      context: context || `Session ended (exit ${code})`,
      processTitle: session?.processTitle || processTitle,
    });

    // Update session info with exit code
    if (session) {
      session.info.exitCode = code;
    }

    if (session?.client) {
      session.client.write(encode({ type: "exited", code }));
      session.client.end();
    }

    xterm.dispose();
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

        session.attaching = true;
        session.attachBuffer = [];
        session.client = socket;
        session.info.attached = true;
        session.lastAttached = Date.now(); // Record attach time for grace period
        session.ctrlBuffer = Buffer.alloc(0);

        // Wait for any pending xterm writes to complete
        const sendState = () => {
          if (session.pendingWrites > 0) {
            setTimeout(sendState, 10);
            return;
          }

          try {
            // Get serialized terminal state (including modes) for consistent redraws
            const serialized = session.serialize.serialize();

            // Send reset first to clear any bad modes, then restore content
            socket.write(TERM_RESET);
            socket.write(Buffer.from("\x1b[2J\x1b[H")); // clear + home
            socket.write(Buffer.from(serialized));

            console.log(`[${sessionName}] attached (restored ${serialized.length} chars)`);
          } catch (e) {
            console.log(`[${sessionName}] serialize error:`, e);
            // Fallback: just send a reset
            socket.write(TERM_RESET);
            socket.write(Buffer.from("\x1b[2J\x1b[H"));
          }

          const drainAttachBuffer = () => {
            const buffered = session.attachBuffer;
            session.attachBuffer = [];
            for (const chunk of buffered) {
              session.pendingWrites++;
              session.xterm.write(chunk, () => {
                session.pendingWrites--;
              });
              socket.write(chunk);
            }
          };

          const attachStart = Date.now();
          const finalizeAttach = () => {
            if (session.attachBuffer.length > 0) {
              drainAttachBuffer();
            }

            if ((session.pendingWrites > 0 || session.attachBuffer.length > 0) &&
                Date.now() - attachStart < 200) {
              setTimeout(finalizeAttach, 10);
              return;
            }

            const core = (session.xterm as any)._core;
            const isCursorHidden = core?.coreService?.isCursorHidden;
            if (typeof isCursorHidden === "boolean") {
              socket.write(Buffer.from(isCursorHidden ? "\x1b[?25l" : "\x1b[?25h"));
            }

            const cursorStyle = session.xterm.options.cursorStyle;
            const cursorBlink = session.xterm.options.cursorBlink;
            let cursorStyleParam: number | null = null;
            if (cursorStyle === "block") {
              cursorStyleParam = cursorBlink ? 2 : 1;
            } else if (cursorStyle === "underline") {
              cursorStyleParam = cursorBlink ? 4 : 3;
            } else if (cursorStyle === "bar") {
              cursorStyleParam = cursorBlink ? 6 : 5;
            }
            if (cursorStyleParam !== null) {
              socket.write(Buffer.from(`\x1b[${cursorStyleParam} q`));
            }

            session.attaching = false;

            socket.write(encode({ type: "attached" }));

            // Set terminal title
            sendTitle(socket, sessionName, session.processTitle);
          };

          finalizeAttach();
        };

        sendState();
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
                session.ptyTerminal.resize(ctrl.cols, ctrl.rows);
                session.xterm.resize(ctrl.cols, ctrl.rows);
                // Send SIGWINCH to process group so children (vim, etc.) get it
                process.kill(-proc.pid, "SIGWINCH");
              } catch {
                try { process.kill(proc.pid, "SIGWINCH"); } catch {}
              }
            } else if (ctrl.type === "detach") {
              // Send reset before detaching to clean up client terminal
              socket.write(TERM_RESET);
              session.client = null;
              session.info.attached = false;
              session.attaching = false;
              session.attachBuffer = [];
              session.lastDetached = Date.now(); // Record detach time for grace period
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
            session.ptyTerminal.write(buf.subarray(offset, end));
            // Track last interaction time
            session.lastInteraction = Date.now();
            offset = end;
          }
        }
      },

      close(socket) {
        const session = sessions.get(id);
        if (session && session.client === socket) {
          session.client = null;
          session.info.attached = false;
          session.attaching = false;
          session.attachBuffer = [];
          console.log(`[${sessionName}] disconnected`);
        }
      }
    }
  });

  sessions.set(id, {
    info,
    ptyTerminal,
    xterm,
    serialize,
    proc,
    client: null,
    ctrlBuffer: Buffer.alloc(0),
    pendingWrites: 0,
    attaching: false,
    attachBuffer: [],
    processTitle: '',
    lastInteraction: 0,  // No interaction yet
    lastDetached: 0,  // Never detached yet
    lastAttached: 0,  // Never attached yet (will be set on first attach)
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

      // Helper to get session info with current processTitle
      const getSessionInfo = (s: SessionData): Session => ({
        ...s.info,
        processTitle: s.processTitle || undefined,
      });

      switch (cmd.type) {
        case "list":
          res = {
            type: "sessions",
            sessions: Array.from(sessions.values()).map(getSessionInfo)
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
            res = { type: "already-attached", session: getSessionInfo(s) };
          } else {
            res = { type: "session", session: getSessionInfo(s) };
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
            s.xterm.dispose();
            s.proc.kill();
          }
          res = { type: "ok" };
          socket.write(JSON.stringify(res));
          setTimeout(() => process.exit(0), 100);
          return;

        case "inbox":
          res = { type: "inbox", items: [...inbox] };
          break;

        case "inbox-clear":
          if (cmd.id) {
            const idx = inbox.findIndex(i => i.id === cmd.id);
            if (idx !== -1) inbox.splice(idx, 1);
          } else {
            inbox.length = 0;
          }
          broadcastTitleUpdate();
          res = { type: "ok" };
          break;

        case "inbox-read": {
          const item = inbox.find(i => i.id === cmd.id);
          if (item) item.read = true;
          broadcastTitleUpdate();
          res = { type: "ok" };
          break;
        }

        default:
          res = { type: "error", message: "Unknown command" };
      }

      socket.write(JSON.stringify(res));
    }
  }
});

console.log("tmux-lite server running (xterm-headless)");
console.log(`Socket: ${ROUTER_SOCKET}\n`);
