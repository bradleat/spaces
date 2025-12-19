#!/usr/bin/env bun
/**
 * tmux-lite CLI
 *
 * Commands:
 *   tl new [name]     Create new session
 *   tl a|attach [id]  Attach to session
 *   tl ls|list        List sessions
 *   tl kill <id>      Kill a session
 *   tl kill-server    Stop the server
 */

import { spawn } from "bun";
import { existsSync } from "fs";
import { select } from "@inquirer/prompts";
import {
  ROUTER_SOCKET,
  type Command,
  type Response,
  type Session,
  type SessionEvent,
  encode,
  isCtrlMagic,
  decode,
  ctrlMsgLen,
} from "./protocol";

const args = process.argv.slice(2);
const cmd = args[0] || "list";

// Check if server is running
async function serverRunning(): Promise<boolean> {
  if (!existsSync(ROUTER_SOCKET)) return false;
  try {
    await send({ type: "list" });
    return true;
  } catch {
    return false;
  }
}

// Send command to server
async function send(cmd: Command): Promise<Response> {
  return new Promise(async (resolve, reject) => {
    try {
      const socket = await Bun.connect({
        unix: ROUTER_SOCKET,
        socket: {
          data(socket, data) {
            resolve(JSON.parse(data.toString()));
            socket.end();
          },
          error(_, e) { reject(e); },
          connectError(_, e) { reject(e); }
        }
      });
      socket.write(JSON.stringify(cmd));
    } catch (e) {
      reject(e);
    }
  });
}

// Format session for display
function formatSession(s: Session): string {
  const age = Math.floor((Date.now() - s.createdAt) / 1000);
  const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age/60)}m` : `${Math.floor(age/3600)}h`;
  const status = s.attached ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
  return `${status} ${s.id}: ${s.name} (${ageStr}) ${s.cwd}`;
}

// Ctrl+Esc sequences (different terminals send different formats)
const CTRL_ESC_CSI_U = Buffer.from([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x35, 0x75]); // ESC [ 27;5u
const CTRL_ESC_XTERM = Buffer.from([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x35, 0x3b, 0x32, 0x37, 0x7e]); // ESC [ 27;5;27 ~

function containsCtrlEsc(buf: Buffer): number {
  const idx1 = buf.indexOf(CTRL_ESC_CSI_U);
  const idx2 = buf.indexOf(CTRL_ESC_XTERM);
  if (idx1 === -1) return idx2;
  if (idx2 === -1) return idx1;
  return Math.min(idx1, idx2);
}

// Attach to a session
async function attach(session: Session) {
  console.log(`Attaching to ${session.name}...`);
  console.log("Ctrl+Esc to detach\n");

  let buffer = Buffer.alloc(0);
  let attached = false;
  let inputBuffer = Buffer.alloc(0);

  const socket = await Bun.connect({
    unix: session.socketPath,
    socket: {
      data(socket, data) {
        let buf = Buffer.from(data);

        // Prepend buffered data
        if (buffer.length > 0) {
          buf = Buffer.concat([buffer, buf]);
          buffer = Buffer.alloc(0);
        }

        let offset = 0;
        while (offset < buf.length) {
          if (isCtrlMagic(buf, offset)) {
            const len = ctrlMsgLen(buf, offset);
            if (len < 0 || offset + len > buf.length) {
              // Incomplete control message
              buffer = buf.subarray(offset);
              break;
            }

            const event = decode(buf, offset) as SessionEvent;

            if (event.type === "attached") {
              attached = true;
              // Trigger resize to redraw full-screen apps
              setTimeout(() => {
                const cols = process.stdout.columns || 80;
                const rows = process.stdout.rows || 24;
                socket.write(encode({ type: "resize", cols: cols - 1, rows }));
                setTimeout(() => {
                  socket.write(encode({ type: "resize", cols, rows }));
                }, 50);
              }, 100);
            } else if (event.type === "exited") {
              process.stdin.setRawMode(false);
              console.log(`\n[exited: ${event.code}]`);
              process.exit(event.code);
            } else if (event.type === "kicked") {
              process.stdin.setRawMode(false);
              console.log("\n[kicked - another client took over]");
              process.exit(0);
            }

            offset += len;
          } else {
            // Raw PTY output - find next control magic or end
            let end = offset + 1;
            while (end < buf.length && !isCtrlMagic(buf, end)) {
              end++;
            }
            process.stdout.write(buf.subarray(offset, end));
            offset = end;
          }
        }
      },

      close() {
        process.stdin.setRawMode(false);
        console.log("\n[disconnected]");
        process.exit(0);
      },

      error(_, e) {
        process.stdin.setRawMode(false);
        console.error("\n[error]", e.message);
        process.exit(1);
      }
    }
  });

  // Initial resize
  socket.write(encode({
    type: "resize",
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
  }));

  // Handle resize via SIGWINCH
  process.on("SIGWINCH", () => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    socket.write(encode({ type: "resize", cols, rows }));
  });

  // Forward stdin
  process.stdin.setRawMode(true);
  process.stdin.resume();

  for await (const chunk of process.stdin) {
    // Check for Ctrl+Esc sequence
    const combined = Buffer.concat([inputBuffer, chunk]);

    // Look for Ctrl+Esc anywhere in the buffer
    const ctrlEscIndex = containsCtrlEsc(combined);
    if (ctrlEscIndex !== -1) {
      // Send everything before Ctrl+Esc to the PTY
      if (ctrlEscIndex > 0) {
        socket.write(combined.subarray(0, ctrlEscIndex));
      }
      // Detach
      socket.write(encode({ type: "detach" }));
      process.stdin.setRawMode(false);
      console.log("\n[detached]");
      process.exit(0);
    }

    // Check if buffer ends with ESC (potential start of sequence)
    if (combined[combined.length - 1] === 0x1b) {
      // Hold back the ESC
      socket.write(combined.subarray(0, -1));
      inputBuffer = combined.subarray(-1);
    } else if (combined.length > 1 && combined[combined.length - 2] === 0x1b) {
      // Hold back ESC + one more byte
      socket.write(combined.subarray(0, -2));
      inputBuffer = combined.subarray(-2);
    } else {
      // Send everything
      socket.write(combined);
      inputBuffer = Buffer.alloc(0);
    }
  }
}

// Main
async function main() {
  // Start server if not running
  if (!(await serverRunning())) {
    if (cmd === "kill-server") {
      console.log("Server not running");
      return;
    }
    console.log("Starting server...");
    spawn({
      cmd: ["bun", "run", `${import.meta.dir}/server.ts`],
      stdout: "inherit",
      stderr: "inherit",
    });
    await Bun.sleep(300);
    if (!(await serverRunning())) {
      console.error("Failed to start server");
      process.exit(1);
    }
  }

  switch (cmd) {
    case "new": {
      const name = args[1];
      const res = await send({ type: "new", name, cwd: process.cwd() });
      if (res.type === "session") {
        await attach(res.session);
      } else if (res.type === "error") {
        console.error("Error:", res.message);
      }
      break;
    }

    case "a":
    case "attach": {
      const id = args[1];
      if (id) {
        const res = await send({ type: "attach", id, force: args.includes("-f") });
        if (res.type === "session") {
          await attach(res.session);
        } else if (res.type === "already-attached") {
          console.log(`Session ${id} is attached elsewhere.\n`);
          const choice = await select({
            message: "What to do?",
            choices: [
              { value: "force", name: "Take over" },
              { value: "cancel", name: "Cancel" },
            ]
          });
          if (choice === "force") {
            const res2 = await send({ type: "attach", id, force: true });
            if (res2.type === "session") await attach(res2.session);
          }
        } else if (res.type === "error") {
          console.error("Error:", res.message);
        }
      } else {
        // No ID - show picker
        const res = await send({ type: "list" });
        if (res.type === "sessions") {
          if (res.sessions.length === 0) {
            console.log("No sessions. Create with: tl new");
          } else {
            const choice = await select({
              message: "Select session:",
              choices: res.sessions.map(s => ({
                value: s.id,
                name: formatSession(s)
              }))
            });
            const res2 = await send({ type: "attach", id: choice });
            if (res2.type === "session") {
              await attach(res2.session);
            } else if (res2.type === "already-attached") {
              const force = await select({
                message: "Session attached. Take over?",
                choices: [
                  { value: true, name: "Yes" },
                  { value: false, name: "No" },
                ]
              });
              if (force) {
                const res3 = await send({ type: "attach", id: choice, force: true });
                if (res3.type === "session") await attach(res3.session);
              }
            }
          }
        }
      }
      break;
    }

    case "ls":
    case "list": {
      const res = await send({ type: "list" });
      if (res.type === "sessions") {
        if (res.sessions.length === 0) {
          console.log("No sessions");
        } else {
          console.log("Sessions:");
          for (const s of res.sessions) {
            console.log("  " + formatSession(s));
          }
        }
      }
      break;
    }

    case "kill": {
      const id = args[1];
      if (!id) {
        console.error("Usage: tl kill <id>");
        process.exit(1);
      }
      const res = await send({ type: "kill", id });
      if (res.type === "ok") {
        console.log(`Killed ${id}`);
      } else if (res.type === "error") {
        console.error("Error:", res.message);
      }
      break;
    }

    case "kill-server": {
      await send({ type: "kill-server" });
      console.log("Server stopped");
      break;
    }

    default:
      console.log(`
tmux-lite

Commands:
  tl new [name]     Create session
  tl attach [id]    Attach (picker if no id)
  tl list           List sessions
  tl kill <id>      Kill session
  tl kill-server    Stop server

In session:
  Ctrl+Esc          Detach
`);
  }
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
