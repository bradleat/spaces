/**
 * tmux-lite protocol
 */

export const ROUTER_SOCKET = "/tmp/tmux-lite.sock";

// Router commands
export type Command =
  | { type: "list" }
  | { type: "new"; name?: string; cwd: string }
  | { type: "attach"; id: string; force?: boolean }
  | { type: "kill"; id: string }
  | { type: "kill-server" };

export type Response =
  | { type: "sessions"; sessions: Session[] }
  | { type: "session"; session: Session }
  | { type: "already-attached"; session: Session }
  | { type: "ok" }
  | { type: "error"; message: string };

export interface Session {
  id: string;
  name: string;
  socketPath: string;
  pid: number;
  attached: boolean;
  cwd: string;
  createdAt: number;
}

// Session control (binary protocol)
// Use a 4-byte magic that's unlikely in terminal output
export const CTRL_MAGIC = Buffer.from([0x1b, 0x5d, 0x39, 0x39]); // ESC ] 9 9

export type SessionCtrl =
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" };

export type SessionEvent =
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
