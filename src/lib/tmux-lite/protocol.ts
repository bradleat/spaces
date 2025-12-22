/**
 * tmux-lite protocol
 */

const DEFAULT_ROUTER_SOCKET = "/tmp/tmux-lite.sock";
const DEFAULT_SESSION_DIR = "/tmp";

export function getRouterSocket(): string {
  return process.env.TMUX_LITE_SOCKET || DEFAULT_ROUTER_SOCKET;
}

export function getSessionSocketPath(id: string): string {
  const dir = process.env.TMUX_LITE_SESSION_DIR || DEFAULT_SESSION_DIR;
  const normalizedDir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${normalizedDir}/tmux-lite-${id}.sock`;
}

// Router commands
export type Command =
  | { type: "list" }
  | { type: "new"; name?: string; cwd: string }
  | { type: "attach"; id: string; force?: boolean }
  | { type: "kill"; id: string }
  | { type: "kill-server" }
  | { type: "inbox" }
  | { type: "inbox-clear"; id?: string }  // Clear one or all
  | { type: "inbox-read"; id: string };   // Mark as read

export type Response =
  | { type: "sessions"; sessions: Session[] }
  | { type: "session"; session: Session }
  | { type: "already-attached"; session: Session }
  | { type: "ok" }
  | { type: "error"; message: string }
  | { type: "inbox"; items: InboxItem[] };

export interface Session {
  id: string;
  name: string;
  socketPath: string;
  pid: number;
  attached: boolean;
  cwd: string;
  createdAt: number;
  exitCode?: number;  // undefined = running, number = exited
  processTitle?: string;  // Title set by running process (e.g., vim, npm run dev)
}

// Inbox item - things that need attention
export interface InboxItem {
  id: string;
  sessionId: string;
  sessionName: string;
  type: 'bell' | 'exit' | 'title' | 'idle';
  timestamp: number;
  exitCode?: number;
  context: string;  // The actual message/output
  processTitle?: string;  // What process was running (e.g., "claude", "npm run dev")
  read: boolean;
}

// Session control (binary protocol)
// Use a 4-byte magic that's unlikely in terminal output
export const CTRL_MAGIC = Buffer.from([0x1b, 0x5d, 0x39, 0x39]); // ESC ] 9 9

export type SessionCtrl =
  | { type: "attach-init"; cols: number; rows: number; clientType?: "cli" | "web" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" };

export type SessionEvent =
  | { type: "attach-ready"; cols: number; rows: number }
  | { type: "attached" }
  | { type: "exited"; code: number }
  | { type: "kicked" };

export function encode(msg: SessionCtrl | SessionEvent): Buffer {
  const json = JSON.stringify(msg);
  const buf = Buffer.alloc(4 + 4 + json.length);
  CTRL_MAGIC.copy(buf, 0);
  buf.writeUInt32BE(json.length, 4);
  buf.write(json, 8);
  return buf;
}

export function isCtrlMagic(data: Buffer, offset: number): boolean {
  if (offset + 4 > data.length) return false;
  return data[offset] === 0x1b &&
         data[offset + 1] === 0x5d &&
         data[offset + 2] === 0x39 &&
         data[offset + 3] === 0x39;
}

export function decode(data: Buffer, offset = 0): SessionCtrl | SessionEvent {
  const len = data.readUInt32BE(offset + 4);
  return JSON.parse(data.subarray(offset + 8, offset + 8 + len).toString());
}

export function ctrlMsgLen(data: Buffer, offset: number): number {
  if (offset + 8 > data.length) return -1; // Need more data
  const jsonLen = data.readUInt32BE(offset + 4);
  return 8 + jsonLen;
}
