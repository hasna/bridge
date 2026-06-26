import { access } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { BridgeMessage, IMessageChannelConfig } from "../types.js";
import { homeDir } from "./paths.js";

export interface IMessageDiagnostic {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface IMessageRow {
  rowId: number;
  handle: string;
  chatGuid?: string;
  displayName?: string;
  text: string;
  date?: number;
}

export interface SendIMessageOptions {
  run?: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  allowChatTarget?: boolean;
}

export function defaultMessagesDbPath(): string {
  return join(homeDir(), "Library", "Messages", "chat.db");
}

export function imessageHandleAllowed(channel: IMessageChannelConfig, handle: string | undefined): boolean {
  if (channel.allowAllHandles) return true;
  if (!channel.allowedHandles?.length) return false;
  return Boolean(handle && channel.allowedHandles.includes(handle));
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

export function renderSendIMessageScript(channel: IMessageChannelConfig, handle: string, text: string): string {
  const service = channel.serviceName || "iMessage";
  const serviceSelector = channel.account
    ? `1st service whose name = ${appleScriptString(service)} and account = ${appleScriptString(channel.account)}`
    : `1st service whose name = ${appleScriptString(service)}`;
  const targetLines = handle.startsWith("chat:")
    ? [
      `set targetChat to 1st chat whose id = ${appleScriptString(handle.slice("chat:".length))}`,
      `send ${appleScriptString(text)} to targetChat`,
    ]
    : [
      `set targetBuddy to buddy ${appleScriptString(handle)} of targetService`,
      `send ${appleScriptString(text)} to targetBuddy`,
    ];
  return [
    "tell application \"Messages\"",
    `set targetService to ${serviceSelector}`,
    ...targetLines,
    "end tell",
  ].join("\n");
}

async function defaultRun(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function sendIMessage(
  channel: IMessageChannelConfig,
  handle: string,
  text: string,
  options: SendIMessageOptions = {},
): Promise<{ ok: true }> {
  if (!(options.allowChatTarget && handle.startsWith("chat:")) && !imessageHandleAllowed(channel, handle)) {
    throw new Error(`iMessage handle is not allowed for channel ${channel.id}: ${handle}`);
  }
  const script = renderSendIMessageScript(channel, handle, text);
  const result = await (options.run || defaultRun)(["osascript", "-e", script]);
  if (result.exitCode !== 0) {
    throw new Error(`iMessage send failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
  return { ok: true };
}

function imessageDateToIso(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return new Date().toISOString();
  const appleEpochMs = Date.UTC(2001, 0, 1);
  if (value > 1e15) return new Date(appleEpochMs + Math.floor(value / 1_000_000)).toISOString();
  if (value > 1e9) return new Date(appleEpochMs + value * 1000).toISOString();
  return new Date(appleEpochMs + value).toISOString();
}

export function getIMessageDbPath(channel: IMessageChannelConfig): string {
  return channel.chatDbPath || defaultMessagesDbPath();
}

export function getIMessageMessages(
  channel: IMessageChannelConfig,
  options: { afterRowId?: number; limit?: number } = {},
): IMessageRow[] {
  if ((channel.receiveMode || "disabled") !== "chat-db") return [];
  const db = new Database(getIMessageDbPath(channel), { readonly: true });
  try {
    const limit = options.limit || channel.pollLimit || 50;
    const scanLimit = Math.max(limit * 10, limit);
    const rows = db.query(`
      select
        message.ROWID as rowId,
        handle.id as handle,
        chat.guid as chatGuid,
        chat.display_name as displayName,
        message.text as text,
        message.date as date
      from message
      left join handle on message.handle_id = handle.ROWID
      left join chat_message_join on chat_message_join.message_id = message.ROWID
      left join chat on chat.ROWID = chat_message_join.chat_id
      where message.ROWID > ?
        and message.is_from_me = 0
        and message.text is not null
      order by message.ROWID asc
      limit ?
    `).all(options.afterRowId || 0, scanLimit) as Array<{
      rowId: number;
      handle?: string;
      chatGuid?: string;
      displayName?: string;
      text?: string;
      date?: number;
    }>;
    return rows
      .filter((row) => row.handle && row.text && imessageHandleAllowed(channel, row.handle))
      .slice(0, limit)
      .map((row) => {
        const item: IMessageRow = { rowId: row.rowId, handle: row.handle!, text: row.text!, date: row.date };
        if (row.chatGuid) item.chatGuid = row.chatGuid;
        if (row.displayName) item.displayName = row.displayName;
        return item;
      });
  } finally {
    db.close();
  }
}

export function imessageRowToMessage(channelId: string, row: IMessageRow): BridgeMessage {
  return {
    id: `imessage:${row.rowId}`,
    channelId,
    chatId: row.chatGuid ? `chat:${row.chatGuid}` : row.handle,
    responseTargetId: row.chatGuid ? `chat:${row.chatGuid}` : row.handle,
    from: row.handle,
    text: row.text,
    receivedAt: imessageDateToIso(row.date),
    raw: row,
  };
}

async function commandExists(command: string): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-lc", `command -v ${command} >/dev/null 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function diagnoseIMessage(channel: IMessageChannelConfig): Promise<IMessageDiagnostic[]> {
  const checks: IMessageDiagnostic[] = [];
  checks.push({
    name: `imessage-platform:${channel.id}`,
    ok: process.platform === "darwin",
    detail: process.platform === "darwin" ? "macOS" : `unsupported platform: ${process.platform}`,
  });
  checks.push({
    name: `imessage-osascript:${channel.id}`,
    ok: await commandExists("osascript"),
    detail: "required for Messages send automation",
  });
  checks.push({
    name: `imessage-allowlist:${channel.id}`,
    ok: Boolean(channel.allowAllHandles || channel.allowedHandles?.length),
    detail: channel.allowAllHandles ? "allowAllHandles=true" : `${channel.allowedHandles?.length || 0} handle(s)`,
  });

  if ((channel.receiveMode || "disabled") === "chat-db") {
    const path = getIMessageDbPath(channel);
    try {
      await access(path);
      checks.push({ name: `imessage-chat-db:${channel.id}`, ok: true, detail: path });
    } catch (err) {
      checks.push({
        name: `imessage-chat-db:${channel.id}`,
        ok: false,
        detail: `${path}: ${err instanceof Error ? err.message : String(err)}. Grant Full Disk Access to the terminal/daemon host or disable receive mode.`,
      });
    }
  } else {
    checks.push({ name: `imessage-receive:${channel.id}`, ok: true, detail: "receiveMode=disabled" });
  }

  return checks;
}
