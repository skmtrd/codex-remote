import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  type BridgeClientMessage,
  type BridgeServerMessage,
  type ChatEntry,
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
const defaultModel = process.env.CODEX_MODEL || "gpt-5.4";
const tokenPath = path.join(projectRoot, ".codex-remote-token");
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

      if (msg.method === "item/agentMessage/delta") {
        const delta = typeof msg.params?.delta === "string" ? msg.params.delta : "";
        if (delta) this.emit({ type: "assistantDelta", text: delta });
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
    if (!cleanText) return;
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
    const userEntry = newEntry("user", text);
    this.history.push(userEntry);
    this.emit({ type: "user", entry: userEntry });

    const access = accessParams(message.options.accessMode);
    const params = {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      ...(message.options.model ? { model: message.options.model } : {}),
      ...(isReasoningEffort(message.options.effort) ? { effort: message.options.effort } : {}),
      approvalPolicy: access.approvalPolicy,
      sandboxPolicy: access.sandboxPolicy,
    };
    this.request("turn/start", params);
  }

  private approval(request: unknown, decision: "accept" | "decline") {
    if (!request || typeof request !== "object") return;
    const requestMsg = request as RpcMessage;
    if (!requestMsg.id || !requestMsg.method) return;
    this.upstream.send(
      JSON.stringify({
        id: requestMsg.id,
        result: { decision: decision === "accept" ? "accept" : "decline" },
      }),
    );
    this.emit({
      type: "status",
      entry: newEntry("status", decision === "accept" ? "承認しました。" : "拒否しました。"),
    });
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
