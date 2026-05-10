import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import {
  newEntry,
  type AccessModeId,
  type ApprovalDecision,
  type BridgeClientMessage,
  type BridgeServerMessage,
  type CapabilityItem,
  type CapabilitySummary,
  type ChatEntry,
  type FileSearchResult,
  type PromptAttachment,
  type PromptMention,
  type ReasoningEffort,
  type ThreadSummary,
} from "../shared/protocol.js";

type RpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type PendingMethod = "initialize" | "thread/start" | "thread/resume" | "turn/start" | string;

const projectRoot = process.cwd();
loadEnvFile(path.join(projectRoot, ".env"));
const clientRoot = path.join(projectRoot, "dist", "client");
const codexBin = process.env.CODEX_BIN || path.join(projectRoot, "node_modules", ".bin", "codex");
const uiPort = Number(process.env.CODEX_REMOTE_PORT || 45214);
const codexPort = Number(process.env.CODEX_APP_SERVER_PORT || 45213);
const codexSocketPath = process.env.CODEX_APP_SERVER_SOCK || "";
const codexEndpoint =
  process.env.CODEX_APP_SERVER_URL || (codexSocketPath ? "ws://codex-app-server/rpc" : `ws://127.0.0.1:${codexPort}`);
const managedCodexServer = !process.env.CODEX_APP_SERVER_URL && !codexSocketPath;
const workdir = process.env.CODEX_WORKDIR || projectRoot;
const defaultModel = process.env.CODEX_MODEL || "gpt-5.5";
const tokenPath = path.join(projectRoot, ".codex-remote-token");
const uploadRoot = path.join(projectRoot, ".uploads");
const bridges = new Map<string, SharedBridge>();

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function getToken() {
  if (process.env.CODEX_REMOTE_TOKEN) return process.env.CODEX_REMOTE_TOKEN;
  if (existsSync(tokenPath)) return readFileSync(tokenPath, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry): entry is os.NetworkInterfaceInfo => Boolean(entry && entry.family === "IPv4" && !entry.internal))
    .map((entry) => entry.address);
}

function bridgeUrls(token: string) {
  const addresses = ["127.0.0.1", ...lanAddresses()];
  return [...new Set(addresses)].map((address) => `http://${address}:${uiPort}/?token=${encodeURIComponent(token)}`);
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function parseRpcMessage(data: RawData): RpcMessage | null {
  try {
    return JSON.parse(data.toString()) as RpcMessage;
  } catch {
    return null;
  }
}

function imageExtension(mediaType: string, name: string) {
  const normalized = mediaType.toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  const ext = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  return "";
}

function decodeDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error("画像添付の形式が不正です。");
  return {
    mediaType: match[1],
    data: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

function savePromptAttachments(attachments: PromptAttachment[] = []): Array<{ type: "localImage"; path: string }> {
  if (attachments.length > 6) throw new Error("画像添付は一度に 6 件までです。");
  mkdirSync(uploadRoot, { recursive: true, mode: 0o700 });
  return attachments.map((attachment) => {
    const decoded = decodeDataUrl(attachment.dataUrl);
    const mediaType = attachment.mediaType || decoded.mediaType;
    const ext = imageExtension(mediaType, attachment.name);
    if (!ext) throw new Error(`${attachment.name || "画像"} は未対応の画像形式です。`);
    if (decoded.data.byteLength > 8 * 1024 * 1024) throw new Error(`${attachment.name || "画像"} が 8MB を超えています。`);
    const filePath = path.join(uploadRoot, `${Date.now()}-${randomBytes(8).toString("hex")}${ext}`);
    writeFileSync(filePath, decoded.data, { mode: 0o600 });
    return { type: "localImage", path: filePath };
  });
}

function promptMentions(mentions: PromptMention[] = []): Array<{ type: "mention"; name: string; path: string }> {
  return mentions
    .filter((mention) => mention.path && mention.name)
    .slice(0, 12)
    .map((mention) => ({ type: "mention", name: mention.name, path: mention.path }));
}

function createUpstreamWebSocket() {
  if (!codexSocketPath) return new WebSocket(codexEndpoint);
  return new WebSocket(codexEndpoint, {
    perMessageDeflate: false,
    createConnection: () => net.createConnection(codexSocketPath),
  });
}

function startCodexServer() {
  const child = spawn(codexBin, ["app-server", "--listen", codexEndpoint], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PATH: `${path.join(projectRoot, "node_modules", ".bin")}:${process.env.PATH || ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[codex] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[codex] ${chunk}`));
  child.on("exit", (code, signal) => {
    console.error(`[codex] exited code=${code} signal=${signal}`);
  });
  return child;
}

function waitForCodexReady() {
  const readyUrl = `http://127.0.0.1:${codexPort}/readyz`;
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const req = http.get(readyUrl, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
    };
    const retry = () => {
      if (Date.now() - startedAt > 15_000) {
        reject(new Error("Codex app-server did not become ready within 15 seconds"));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function appServerRequest(method: string, params: Record<string, unknown>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const upstream = createUpstreamWebSocket();
    let nextId = 1;
    const pending = new Map<number, string>();
    const timeout = setTimeout(() => {
      upstream.close();
      reject(new Error(`${method} timed out`));
    }, 12_000);

    const sendRequest = (requestMethod: string, requestParams: Record<string, unknown>) => {
      const id = nextId++;
      pending.set(id, requestMethod);
      upstream.send(JSON.stringify({ id, method: requestMethod, params: requestParams }));
    };

    upstream.on("open", () => {
      sendRequest("initialize", {
        clientInfo: { name: "codex-remote", title: "Codex Remote", version: "0.1.0" },
      });
      upstream.send(JSON.stringify({ method: "initialized", params: {} }));
      sendRequest(method, params);
    });

    upstream.on("message", (data) => {
      const msg = parseRpcMessage(data);
      if (!msg?.id || pending.get(msg.id) !== method) return;
      clearTimeout(timeout);
      upstream.close();
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    });

    upstream.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function stripUiDirectives(text: unknown) {
  return String(text || "")
    .replace(/(?:^|\n)::[a-z0-9-]+\{[^\n]*\}(?=\n|$)/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeItem(item: Record<string, unknown>): ChatEntry | null {
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map((part) => (typeof part === "object" && part && "text" in part ? String(part.text || "") : ""))
      .filter(Boolean)
      .join("\n");
    return text ? newEntry("user", text) : null;
  }

  if (item.type === "agentMessage") {
    const text = stripUiDirectives(item.text);
    return text ? newEntry("assistant", text) : null;
  }

  if (item.type === "commandExecution") {
    return newEntry("status", `$ ${String(item.command || "")}`);
  }

  if (item.type === "fileChange") {
    return newEntry("status", `file changes: ${String(item.status || "updated")}`);
  }

  return null;
}

function summarizeLiveItem(item: unknown, phase: "started" | "completed") {
  if (!item || typeof item !== "object") return "";
  const value = item as Record<string, unknown>;
  if (value.type === "commandExecution" && phase === "started") return `$ ${String(value.command || "")}`;
  if (value.type === "fileChange") return `file changes: ${String(value.status || "updated")}`;
  return "";
}

function summarizePlanUpdate(params: Record<string, unknown>) {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  if (plan.length === 0) return "";
  const explanation = typeof params.explanation === "string" && params.explanation.trim() ? `${params.explanation.trim()}\n` : "";
  const steps = plan
    .map((step) => {
      if (!step || typeof step !== "object") return "";
      const record = step as Record<string, unknown>;
      const label = record.status === "completed" ? "[x]" : record.status === "inProgress" ? "[>]" : "[ ]";
      return `${label} ${String(record.step || "")}`;
    })
    .filter(Boolean)
    .join("\n");
  return steps ? `Plan updated\n${explanation}${steps}` : "";
}

function summarizeDiffUpdate(params: Record<string, unknown>) {
  const diff = typeof params.diff === "string" ? params.diff.trim() : "";
  if (!diff) return "";
  const files = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2] || match[1]);
  const fileSummary = files.length ? files.slice(0, 8).map((file) => `- ${file}`).join("\n") : diff.split("\n").slice(0, 8).join("\n");
  const suffix = files.length > 8 ? `\n...and ${files.length - 8} more` : "";
  return `Diff updated (${files.length || 1} file${files.length === 1 ? "" : "s"})\n${fileSummary}${suffix}`;
}

function summarizeNotice(method: string, params: Record<string, unknown>) {
  if (method === "model/rerouted") {
    return `Model rerouted\n${String(params.fromModel || "unknown")} -> ${String(params.toModel || "unknown")}\nReason: ${String(params.reason || "unknown")}`;
  }
  if (method === "model/verification") {
    const verifications = Array.isArray(params.verifications) ? params.verifications.map(String) : [];
    return verifications.length ? `Model verification\n${verifications.join(", ")}` : "";
  }
  if (method === "warning" || method === "guardianWarning") {
    const message = typeof params.message === "string" ? params.message : "";
    return message ? `Warning\n${message}` : "";
  }
  if (method === "configWarning") {
    const summary = typeof params.summary === "string" ? params.summary : "";
    const details = typeof params.details === "string" && params.details.trim() ? `\n${params.details.trim()}` : "";
    const filePath = typeof params.path === "string" ? `\n${params.path}` : "";
    return summary ? `Config warning\n${summary}${details}${filePath}` : "";
  }
  if (method === "deprecationNotice") {
    const summary = typeof params.summary === "string" ? params.summary : "";
    const details = typeof params.details === "string" && params.details.trim() ? `\n${params.details.trim()}` : "";
    return summary ? `Deprecation notice\n${summary}${details}` : "";
  }
  return "";
}

function historyFromThread(thread: Record<string, unknown>): ChatEntry[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const history: ChatEntry[] = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== "object") continue;
    const items: unknown[] = Array.isArray((turn as Record<string, unknown>).items)
      ? ((turn as Record<string, unknown>).items as unknown[])
      : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const entry = summarizeItem(item as Record<string, unknown>);
      if (entry) history.push(entry);
    }
  }
  return history.slice(-120);
}

function normalizeThreads(result: Record<string, unknown>): ThreadSummary[] {
  const rawThreads = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.threads)
      ? result.threads
      : Array.isArray(result.items)
        ? result.items
        : [];

  return rawThreads
    .filter((thread): thread is Record<string, unknown> => Boolean(thread && typeof thread === "object"))
    .map((thread) => {
      const id = String(thread.id || thread.threadId || "");
      const cwd = typeof thread.cwd === "string" ? thread.cwd : undefined;
      const preview = typeof thread.preview === "string" ? thread.preview : undefined;
      const titleSource = thread.name || thread.title || preview || cwd || id;
      const title = String(titleSource || id).split("\n").find(Boolean) || id;
      const updatedRaw = thread.updatedAt || thread.updated_at || thread.lastUpdatedAt;
      const updatedAt = typeof updatedRaw === "number" ? updatedRaw : undefined;
      return {
        id,
        title: title.length > 80 ? `${title.slice(0, 80)}...` : title,
        cwd,
        updatedAt,
        preview,
      };
    })
    .filter((thread) => thread.id);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function boolValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeSkillCapabilities(result: Record<string, unknown>): CapabilityItem[] {
  const entries = Array.isArray(result.data) ? result.data : [];
  return entries.flatMap((entry) => {
    const cwd = stringValue(objectValue(entry).cwd);
    const skills = Array.isArray(objectValue(entry).skills) ? (objectValue(entry).skills as unknown[]) : [];
    return skills
      .filter((skill): skill is Record<string, unknown> => Boolean(skill && typeof skill === "object"))
      .map((skill) => {
        const name = stringValue(skill.name) || stringValue(skill.path) || "skill";
        const description = stringValue(skill.shortDescription) || stringValue(skill.description);
        const scope = stringValue(skill.scope);
        return {
          id: stringValue(skill.path) || `${cwd}:${name}`,
          title: name,
          subtitle: scope || cwd,
          description,
          meta: [cwd && projectRoot === cwd ? "current cwd" : cwd, scope, boolValue(skill.enabled) === false ? "disabled" : "enabled"].filter(Boolean),
          enabled: boolValue(skill.enabled),
        };
      });
  });
}

function normalizePluginCapabilities(result: Record<string, unknown>): CapabilityItem[] {
  const marketplaces = Array.isArray(result.marketplaces) ? result.marketplaces : [];
  return marketplaces.flatMap((marketplace) => {
    const record = objectValue(marketplace);
    const marketName = stringValue(record.name) || stringValue(objectValue(record.interface).displayName) || "marketplace";
    const plugins = Array.isArray(record.plugins) ? record.plugins : [];
    return plugins
      .filter((plugin): plugin is Record<string, unknown> => Boolean(plugin && typeof plugin === "object"))
      .map((plugin) => ({
        id: stringValue(plugin.id) || `${marketName}:${stringValue(plugin.name)}`,
        title: stringValue(plugin.name) || stringValue(plugin.id) || "plugin",
        subtitle: marketName,
        description: stringValue(objectValue(plugin.interface).description),
        meta: [
          boolValue(plugin.installed) ? "installed" : "not installed",
          boolValue(plugin.enabled) ? "enabled" : "disabled",
          stringValue(plugin.installPolicy),
          stringValue(plugin.authPolicy),
        ].filter(Boolean),
        enabled: boolValue(plugin.enabled),
      }));
  });
}

function normalizeAppCapabilities(result: Record<string, unknown>): CapabilityItem[] {
  const apps = Array.isArray(result.data) ? result.data : [];
  return apps
    .filter((app): app is Record<string, unknown> => Boolean(app && typeof app === "object"))
    .map((app) => ({
      id: stringValue(app.id) || stringValue(app.name),
      title: stringValue(app.name) || stringValue(app.id) || "app",
      subtitle: stringValue(app.distributionChannel),
      description: stringValue(app.description),
      meta: [
        boolValue(app.isAccessible) ? "accessible" : "not accessible",
        boolValue(app.isEnabled) ? "enabled" : "disabled",
        ...(Array.isArray(app.pluginDisplayNames) ? app.pluginDisplayNames.map(String).slice(0, 2) : []),
      ].filter(Boolean),
      enabled: boolValue(app.isEnabled),
    }));
}

function normalizeMcpCapabilities(result: Record<string, unknown>): CapabilityItem[] {
  const servers = Array.isArray(result.data) ? result.data : [];
  return servers
    .filter((server): server is Record<string, unknown> => Boolean(server && typeof server === "object"))
    .map((server) => {
      const tools = objectValue(server.tools);
      const resources = Array.isArray(server.resources) ? server.resources : [];
      const templates = Array.isArray(server.resourceTemplates) ? server.resourceTemplates : [];
      const toolNames = Object.keys(tools);
      return {
        id: stringValue(server.name) || "mcp",
        title: stringValue(server.name) || "MCP server",
        subtitle: stringValue(server.authStatus),
        description: toolNames.slice(0, 4).join(", "),
        meta: [`${toolNames.length} tools`, `${resources.length} resources`, `${templates.length} templates`, stringValue(server.authStatus)].filter(Boolean),
        enabled: true,
      };
    });
}

function normalizeCapabilities(results: Array<PromiseSettledResult<Record<string, unknown>>>): CapabilitySummary {
  const errors: string[] = [];
  const value = (index: number, label: string) => {
    const result = results[index];
    if (result.status === "fulfilled") return result.value;
    errors.push(`${label}: ${toError(result.reason).message}`);
    return {};
  };
  return {
    skills: normalizeSkillCapabilities(value(0, "skills")),
    plugins: normalizePluginCapabilities(value(1, "plugins")),
    apps: normalizeAppCapabilities(value(2, "apps")),
    mcpServers: normalizeMcpCapabilities(value(3, "mcp")),
    errors,
  };
}

function normalizeFileSearchResults(result: Record<string, unknown>): FileSearchResult[] {
  const files = Array.isArray(result.files) ? result.files : [];
  return files
    .filter((file): file is Record<string, unknown> => Boolean(file && typeof file === "object"))
    .map((file) => ({
      root: stringValue(file.root),
      path: stringValue(file.path),
      fileName: stringValue(file.file_name) || path.basename(stringValue(file.path)),
      score: typeof file.score === "number" ? file.score : undefined,
    }))
    .filter((file) => file.path)
    .slice(0, 20);
}

function accessParams(accessMode: AccessModeId) {
  if (accessMode === "full") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  if (accessMode === "read-only") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: true },
    };
  }
  return {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workdir],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(value));
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return ["accept", "acceptForSession", "decline", "cancel"].includes(String(value));
}

function responseDecisionFor(method: string, decision: ApprovalDecision) {
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    if (decision === "accept") return "approved";
    if (decision === "acceptForSession") return "approved_for_session";
    if (decision === "cancel") return "abort";
    return "denied";
  }
  return decision;
}

function approvalStatusText(decision: ApprovalDecision) {
  if (decision === "accept") return "承認しました。";
  if (decision === "acceptForSession") return "このセッションで承認しました。";
  if (decision === "cancel") return "キャンセルしました。";
  return "拒否しました。";
}

async function warmHistory(threadId: string) {
  await appServerRequest("thread/read", { threadId, includeTurns: true });
  await appServerRequest("thread/list", {
    limit: 30,
    sortKey: "updated_at",
    sortDirection: "desc",
    archived: false,
    cwd: workdir,
    useStateDbOnly: false,
  });
}

class SharedBridge {
  private upstream = createUpstreamWebSocket();
  private clients = new Set<WebSocket>();
  private nextId = 1;
  private pending = new Map<number, PendingMethod>();
  private threadId = "";
  private activeTurnId = "";
  private ready = false;
  private history: ChatEntry[] = [];
  private queue: Array<{ text: string; options: BridgeClientMessage & { type: "prompt" } }> = [];

  constructor(
    private requestedThreadId: string | null,
    private bridgeKey: string,
  ) {
    this.bindUpstream();
  }

  addClient(client: WebSocket) {
    this.clients.add(client);
    this.emitTo(client, { type: "status", entry: newEntry("status", "Codex bridge に接続しました。") });
    if (this.ready) this.emitTo(client, this.readyPayload());
    client.on("close", () => {
      this.clients.delete(client);
      if (this.clients.size === 0) {
        this.upstream.close();
        bridges.delete(this.bridgeKey);
      }
    });
  }

  dispose() {
    this.upstream.close();
    for (const client of this.clients) client.close();
    this.clients.clear();
  }

  handleClientMessage(data: RawData) {
    let msg: BridgeClientMessage;
    try {
      msg = JSON.parse(data.toString()) as BridgeClientMessage;
    } catch {
      this.emit({ type: "error", entry: newEntry("error", "Browser message を解釈できませんでした。") });
      return;
    }

    if (msg.type === "prompt") this.prompt(msg.text, msg);
    if (msg.type === "approval") this.approval(msg.request, msg.decision);
    if (msg.type === "interrupt") this.interrupt();
  }

  private readyPayload(): BridgeServerMessage {
    return {
      type: "ready",
      threadId: this.threadId,
      model: defaultModel,
      workdir,
      clients: this.clients.size,
      history: this.history,
    };
  }

  private emit(message: BridgeServerMessage) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  private emitTo(client: WebSocket, message: BridgeServerMessage) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  private request(method: PendingMethod, params: Record<string, unknown>) {
    const id = this.nextId++;
    this.pending.set(id, method);
    this.upstream.send(JSON.stringify({ id, method, params }));
    return id;
  }

  private hasPendingTurn() {
    return Array.from(this.pending.values()).includes("turn/start");
  }

  private promoteBridgeKey() {
    if (!this.threadId || !this.bridgeKey.startsWith("new:")) return;
    if (bridges.has(this.threadId) && bridges.get(this.threadId) !== this) return;
    bridges.delete(this.bridgeKey);
    this.bridgeKey = this.threadId;
    bridges.set(this.threadId, this);
  }

  private bindUpstream() {
    this.upstream.on("open", () => {
      this.request("initialize", {
        clientInfo: { name: "codex-remote-browser", title: "Codex Remote", version: "0.1.0" },
      });
      this.upstream.send(JSON.stringify({ method: "initialized", params: {} }));

      const method: PendingMethod = this.requestedThreadId ? "thread/resume" : "thread/start";
      this.request(method, {
        ...(this.requestedThreadId ? { threadId: this.requestedThreadId } : {}),
        model: defaultModel,
        cwd: workdir,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      this.emit({
        type: "status",
        entry: newEntry("status", this.requestedThreadId ? "既存 thread を再開しています。" : "新しい thread を開始しています。"),
      });
    });

    this.upstream.on("message", (data) => {
      const msg = parseRpcMessage(data);
      if (!msg) return;
      const pendingMethod = msg.id ? this.pending.get(msg.id) : undefined;

      if (pendingMethod === "thread/start" || pendingMethod === "thread/resume") {
        this.pending.delete(msg.id || -1);
        if (msg.error) {
          this.emit({ type: "error", entry: newEntry("error", msg.error.message || "thread の開始に失敗しました。") });
          return;
        }
        const thread = (msg.result?.thread || {}) as Record<string, unknown>;
        this.threadId = String(thread.id || this.requestedThreadId || "");
        if (!this.threadId) {
          this.emit({ type: "error", entry: newEntry("error", "Codex app-server から thread id が返りませんでした。") });
          return;
        }
        this.history = historyFromThread(thread);
        this.ready = true;
        this.promoteBridgeKey();
        this.emit(this.readyPayload());
        return;
      }

      if (pendingMethod === "turn/start") {
        this.pending.delete(msg.id || -1);
        if (msg.error) {
          this.emit({ type: "error", entry: newEntry("error", msg.error.message || "turn の開始に失敗しました。") });
          this.startNextQueuedTurn();
          return;
        }
        const turn = (msg.result?.turn || {}) as Record<string, unknown>;
        this.activeTurnId = String(turn.id || "");
        this.emit({ type: "turn", status: "started", turnId: this.activeTurnId });
        return;
      }

      if (pendingMethod === "turn/interrupt") {
        this.pending.delete(msg.id || -1);
        if (msg.error) {
          if ((msg.error.message || "").toLowerCase().includes("no active turn")) {
            this.emit({ type: "status", entry: newEntry("status", "停止対象の turn は既に終了していました。") });
            return;
          }
          this.emit({ type: "error", entry: newEntry("error", msg.error.message || "turn の停止に失敗しました。") });
          return;
        }
        this.emit({ type: "status", entry: newEntry("status", "停止要求を送信しました。") });
        return;
      }

      if (msg.method === "item/agentMessage/delta") {
        const delta = typeof msg.params?.delta === "string" ? msg.params.delta : "";
        if (delta) this.emit({ type: "assistantDelta", text: delta });
        return;
      }

      if (msg.method === "item/reasoning/summaryTextDelta") {
        const delta = typeof msg.params?.delta === "string" ? msg.params.delta : "";
        if (delta) this.emit({ type: "reasoningDelta", text: delta });
        return;
      }

      if (msg.method === "turn/plan/updated") {
        const text = summarizePlanUpdate(msg.params || {});
        if (text) this.emit({ type: "status", entry: newEntry("status", text) });
        return;
      }

      if (msg.method === "turn/diff/updated") {
        const text = summarizeDiffUpdate(msg.params || {});
        if (text) this.emit({ type: "status", entry: newEntry("status", text) });
        return;
      }

      if (
        msg.method === "model/rerouted" ||
        msg.method === "model/verification" ||
        msg.method === "warning" ||
        msg.method === "guardianWarning" ||
        msg.method === "configWarning" ||
        msg.method === "deprecationNotice"
      ) {
        const text = summarizeNotice(msg.method, msg.params || {});
        if (text) this.emit({ type: "status", entry: newEntry("status", text) });
        return;
      }

      if (msg.method === "item/started") {
        const text = summarizeLiveItem(msg.params?.item, "started");
        if (text) this.emit({ type: "status", entry: newEntry("status", text) });
        return;
      }

      if (msg.method === "item/completed") {
        const item = msg.params?.item;
        if (item && typeof item === "object") {
          const entry = summarizeItem(item as Record<string, unknown>);
          if (entry && entry.role !== "user") this.history.push(entry);
          const liveText = summarizeLiveItem(item, "completed");
          if (liveText) this.emit({ type: "status", entry: newEntry("status", liveText) });
        }
        return;
      }

      if (msg.method === "turn/completed") {
        this.activeTurnId = "";
        this.emit({ type: "turn", status: "completed", turnId: String(msg.params?.turnId || "") });
        if (this.threadId) warmHistory(this.threadId).catch((error: unknown) => {
          this.emit({ type: "status", entry: newEntry("status", `履歴同期に失敗しました: ${toError(error).message}`) });
        });
        this.startNextQueuedTurn();
        return;
      }

      if (msg.method?.endsWith("/requestApproval")) {
        this.emit({ type: "approval", request: msg });
        return;
      }

      if (msg.method === "error") {
        this.emit({ type: "error", entry: newEntry("error", String(msg.params?.message || "Codex error")) });
      }
    });

    this.upstream.on("error", (error) => {
      this.emit({ type: "error", entry: newEntry("error", error.message) });
    });

    this.upstream.on("close", () => {
      this.emit({ type: "status", entry: newEntry("status", "Codex app-server との接続が閉じました。") });
    });
  }

  private prompt(text: string, options: BridgeClientMessage & { type: "prompt" }) {
    const cleanText = text.trim();
    if (!cleanText && !options.attachments?.length && !options.mentions?.length) return;
    if (!this.ready || !this.threadId) {
      this.emit({ type: "error", entry: newEntry("error", "Thread の準備がまだ完了していません。") });
      return;
    }
    if (this.activeTurnId || this.hasPendingTurn()) {
      this.queue.push({ text: cleanText, options });
      this.emit({ type: "status", entry: newEntry("status", `送信をキューに追加しました。残り ${this.queue.length} 件です。`) });
      return;
    }
    this.startPrompt(cleanText, options);
  }

  private startNextQueuedTurn() {
    if (!this.ready || this.activeTurnId || this.hasPendingTurn() || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    this.emit({ type: "status", entry: newEntry("status", `キューから送信しています。残り ${this.queue.length} 件です。`) });
    this.startPrompt(next.text, next.options);
  }

  private startPrompt(text: string, message: BridgeClientMessage & { type: "prompt" }) {
    let imageInputs: Array<{ type: "localImage"; path: string }>;
    try {
      imageInputs = savePromptAttachments(message.attachments || []);
    } catch (error) {
      this.emit({ type: "error", entry: newEntry("error", toError(error).message) });
      this.startNextQueuedTurn();
      return;
    }

    const attachmentText = imageInputs.length ? `\n\n添付画像: ${imageInputs.length}件` : "";
    const mentionInputs = promptMentions(message.mentions || []);
    const mentionText = mentionInputs.length ? `\n\n参照ファイル: ${mentionInputs.map((mention) => mention.path).join(", ")}` : "";
    const userEntry = newEntry("user", `${text || "添付/参照を確認してください。"}${attachmentText}${mentionText}`);
    this.history.push(userEntry);
    this.emit({ type: "user", entry: userEntry });

    const access = accessParams(message.options.accessMode);
    const input = [
      ...(text ? [{ type: "text", text, text_elements: [] }] : []),
      ...mentionInputs,
      ...imageInputs,
    ];
    const params = {
      threadId: this.threadId,
      input,
      ...(message.options.model ? { model: message.options.model } : {}),
      ...(isReasoningEffort(message.options.effort) ? { effort: message.options.effort } : {}),
      approvalPolicy: access.approvalPolicy,
      sandboxPolicy: access.sandboxPolicy,
    };
    this.request("turn/start", params);
  }

  private approval(request: unknown, decision: ApprovalDecision) {
    if (!request || typeof request !== "object") return;
    const requestMsg = request as RpcMessage;
    if (!requestMsg.id || !requestMsg.method) return;
    const normalizedDecision = isApprovalDecision(decision) ? decision : "decline";
    this.upstream.send(
      JSON.stringify({
        id: requestMsg.id,
        result: { decision: responseDecisionFor(requestMsg.method, normalizedDecision) },
      }),
    );
    this.emit({
      type: "status",
      entry: newEntry("status", approvalStatusText(normalizedDecision)),
    });
  }

  private interrupt() {
    if (!this.ready || !this.threadId || !this.activeTurnId) {
      this.emit({ type: "status", entry: newEntry("status", "停止できる実行中 turn はありません。") });
      return;
    }
    this.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });
    this.emit({ type: "status", entry: newEntry("status", "停止を要求しています。") });
  }
}

function bridgeKeyFor(threadId: string | null) {
  return threadId || "new:default";
}

function getBridge(threadId: string | null) {
  const key = bridgeKeyFor(threadId);
  if (!bridges.has(key)) bridges.set(key, new SharedBridge(threadId, key));
  return bridges.get(key);
}

function tokenFromRequest(c: Context) {
  const auth = c.req.header("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return c.req.query("token") || "";
}

function requireAuth(c: Context, token: string) {
  if (tokenFromRequest(c) === token) return null;
  return c.json({ error: "invalid token" }, 401);
}

async function serveClientAsset(pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(clientRoot, requested);
  if (!target.startsWith(`${clientRoot}${path.sep}`) && target !== clientRoot) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const data = await readFile(target);
  const type = mimeTypes.get(path.extname(target).toLowerCase()) || "application/octet-stream";
  return new Response(data, {
    headers: {
      "content-type": type,
      "cache-control": requested.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
    },
  });
}

function createApp(phoneToken: string) {
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/info", (c) =>
    c.json({
      model: defaultModel,
      workdir,
      uiPort,
      codexEndpoint: codexSocketPath || codexEndpoint,
      managedCodexServer,
      tokenRequired: true,
    }),
  );

  app.get("/api/status", (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    return c.json({
      model: defaultModel,
      workdir,
      uiPort,
      codexEndpoint: codexSocketPath || codexEndpoint,
      managedCodexServer,
      bridges: Array.from(bridges.values()).length,
    });
  });

  app.get("/api/capabilities", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const results = await Promise.allSettled([
      appServerRequest("skills/list", { cwds: [workdir], forceReload: false }),
      appServerRequest("plugin/list", { cwds: [workdir], marketplaceKinds: ["local", "workspace-directory", "shared-with-me"] }),
      appServerRequest("app/list", { limit: 100, forceRefetch: false }),
      appServerRequest("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly" }),
    ]);
    return c.json(normalizeCapabilities(results));
  });

  app.get("/api/files/search", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const query = (c.req.query("q") || "").trim();
    if (!query) return c.json({ data: [] });
    try {
      const result = await appServerRequest("fuzzyFileSearch", {
        query,
        roots: [workdir],
        cancellationToken: null,
      });
      return c.json({ data: normalizeFileSearchResults(result) });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.get("/api/threads", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    try {
      const result = await appServerRequest("thread/list", {
        limit: 50,
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: false,
      });
      return c.json({ data: normalizeThreads(result) });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.get("/api/thread", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const threadId = c.req.query("thread");
    if (!threadId) return c.json({ error: "thread is required" }, 400);
    try {
      const result = await appServerRequest("thread/resume", {
        threadId,
        model: defaultModel,
        cwd: workdir,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });
      const thread = (result.thread || {}) as Record<string, unknown>;
      return c.json({ threadId: String(thread.id || threadId), history: historyFromThread(thread) });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.post("/api/thread/name", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!threadId) return c.json({ error: "threadId is required" }, 400);
    if (!name) return c.json({ error: "name is required" }, 400);
    try {
      await appServerRequest("thread/name/set", { threadId, name });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.post("/api/thread/archive", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!threadId) return c.json({ error: "threadId is required" }, 400);
    try {
      await appServerRequest("thread/archive", { threadId });
      bridges.get(threadId)?.dispose();
      bridges.delete(threadId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.post("/api/thread/compact", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!threadId) return c.json({ error: "threadId is required" }, 400);
    try {
      await appServerRequest("thread/compact/start", { threadId });
      bridges.get(threadId)?.dispose();
      bridges.delete(threadId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.post("/api/thread/fork", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    if (!threadId) return c.json({ error: "threadId is required" }, 400);
    try {
      const result = await appServerRequest("thread/fork", {
        threadId,
        model: defaultModel,
        cwd: workdir,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        persistExtendedHistory: false,
        excludeTurns: false,
      });
      const thread = (result.thread || {}) as Record<string, unknown>;
      return c.json({ threadId: String(thread.id || ""), history: historyFromThread(thread) });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.post("/api/thread/rollback", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    const numTurns = Number(body.numTurns || 1);
    if (!threadId) return c.json({ error: "threadId is required" }, 400);
    if (!Number.isInteger(numTurns) || numTurns < 1 || numTurns > 20) return c.json({ error: "numTurns must be 1-20" }, 400);
    try {
      const result = await appServerRequest("thread/rollback", { threadId, numTurns });
      bridges.get(threadId)?.dispose();
      bridges.delete(threadId);
      const thread = (result.thread || {}) as Record<string, unknown>;
      return c.json({ threadId: String(thread.id || threadId), history: historyFromThread(thread) });
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.get("/api/models", async (c) => {
    const authError = requireAuth(c, phoneToken);
    if (authError) return authError;
    try {
      const result = await appServerRequest("model/list", { limit: 80, includeHidden: false });
      return c.json(result);
    } catch (error) {
      return c.json({ error: toError(error).message }, 500);
    }
  });

  app.get("*", async (c) => {
    const direct = await serveClientAsset(new URL(c.req.url).pathname);
    if (direct) return direct;
    const index = await serveClientAsset("/");
    if (index) return index;
    return c.text("Client assets are missing. Run npm run build before npm run start.", 500);
  });

  return app;
}

async function main() {
  const phoneToken = getToken();
  const codexProcess: ChildProcess | null = managedCodexServer ? startCodexServer() : null;

  if (managedCodexServer) {
    await waitForCodexReady();
  } else {
    await appServerRequest("thread/loaded/list", { cursor: null, limit: 1 });
  }

  const app = createApp(phoneToken);
  const wss = new WebSocketServer({ noServer: true });
  const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: uiPort }, () => {
    const urls = bridgeUrls(phoneToken);
    console.log("");
    console.log("Codex Remote is ready.");
    for (const url of urls) console.log(`  ${url}`);
    console.log("");
    console.log(`Workdir: ${workdir}`);
    console.log(`Model:   ${defaultModel}`);
    console.log(`Codex:   ${codexSocketPath || codexEndpoint}`);
    console.log("Press Ctrl+C to stop.");
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/bridge") {
      socket.destroy();
      return;
    }
    if (url.searchParams.get("token") !== phoneToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const threadId = url.searchParams.get("thread") || null;
    const bridge = getBridge(threadId);
    if (!bridge) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      bridge.addClient(client);
      client.on("message", (data) => bridge.handleClientMessage(data));
    });
  });

  const shutdown = () => {
    server.close();
    wss.close();
    if (codexProcess) codexProcess.kill("SIGINT");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(toError(error));
  process.exit(1);
});
