import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ImagePlus,
  Menu,
  PanelLeft,
  Plus,
  RefreshCcw,
  Send,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import type {
  AccessModeId,
  ApprovalDecision,
  BridgeClientMessage,
  BridgeServerMessage,
  ChatEntry,
  PromptAttachment,
  ReasoningEffort,
  RunState,
  ServerInfo,
  ThreadSummary,
} from "../shared/protocol.js";
import "./App.css";

type ReasoningEffortOption = {
  id: ReasoningEffort;
  description?: string;
};

type ModelOption = {
  id: string;
  label: string;
  description?: string;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffortOption[];
  inputModalities: string[];
  isDefault: boolean;
};

const initialParams = new URLSearchParams(window.location.search);
const initialToken = initialParams.get("token") || localStorage.getItem("codexRemoteToken") || "";
const initialThread = initialParams.get("thread") || "";
const initialModel = localStorage.getItem("codexRemoteModel") || "";
const initialEffort = localStorage.getItem("codexRemoteEffort") || "";

const runStateLabel: Record<RunState, string> = {
  booting: "起動中",
  connecting: "接続中",
  ready: "待機中",
  running: "処理中",
  streaming: "生成中",
  approval: "承認待ち",
  done: "完了",
  offline: "切断",
  error: "エラー",
};

const accessModes: Array<{ id: AccessModeId; label: string; short: string }> = [
  { id: "review", label: "確認モード", short: "確認" },
  { id: "full", label: "フルアクセス", short: "フル" },
  { id: "read-only", label: "読み取り専用", short: "読取" },
];

const reasoningEfforts: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const fallbackReasoningOptions: ReasoningEffortOption[] = reasoningEfforts.map((id) => ({ id }));
const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "なし",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "最高",
};
const maxImageAttachments = 6;
const maxImageBytes = 8 * 1024 * 1024;

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return reasoningEfforts.includes(value as ReasoningEffort);
}

function parseReasoningEffortOption(value: unknown): ReasoningEffortOption | null {
  if (isReasoningEffort(value)) return { id: value };
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isReasoningEffort(record.reasoningEffort)) return null;
  return {
    id: record.reasoningEffort,
    description: typeof record.description === "string" ? record.description : undefined,
  };
}

function uniqueReasoningOptions(options: ReasoningEffortOption[]) {
  const seen = new Set<ReasoningEffort>();
  return options.filter((option) => {
    if (seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

const markdownComponents: Components = {
  a({ children, href, ...props }) {
    return (
      <a href={href} rel="noreferrer" target="_blank" {...props}>
        {children}
      </a>
    );
  },
};

type ApprovalInfo = {
  kind: string;
  title: string;
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  network?: string;
  permissions?: string;
  actions: string[];
  fileChanges: string[];
  canAcceptForSession: boolean;
  raw: string;
};

function makeLocalEntry(role: ChatEntry["role"], text: string): ChatEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    text,
    createdAt: Date.now(),
  };
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function apiGet<T>(path: string, token?: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    headers: token ? authHeaders(token) : undefined,
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

function projectName(cwd?: string) {
  if (!cwd) return "No project";
  const clean = cwd.replace(/\/+$/, "");
  return clean.split("/").filter(Boolean).pop() || clean;
}

function relativeTime(value?: number) {
  if (!value) return "";
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSeconds < 60) return "今";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間`;
  return `${Math.floor(hours / 24)}日`;
}

function compactId(id: string) {
  return id.length > 14 ? `${id.slice(0, 7)}...${id.slice(-5)}` : id;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("画像を読み込めませんでした。"));
    reader.readAsDataURL(file);
  });
}

async function fileToAttachment(file: File): Promise<PromptAttachment> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} は画像ではありません。`);
  if (file.size > maxImageBytes) throw new Error(`${file.name} が 8MB を超えています。`);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    dataUrl: await readFileAsDataUrl(file),
  };
}

function approvalHasDecision(params: Record<string, unknown>, decision: ApprovalDecision) {
  return Array.isArray(params.availableDecisions) && params.availableDecisions.some((value) => value === decision);
}

function formatCommandAction(value: unknown) {
  const action = asRecord(value);
  if (!action) return compactJson(value);
  const type = nonEmptyString(action.type);
  const command = nonEmptyString(action.command) || nonEmptyString(action.cmd);
  if (type === "read") return `read: ${nonEmptyString(action.path) || nonEmptyString(action.name) || command || "file"}`;
  if (type === "listFiles" || type === "list_files") return `list: ${nonEmptyString(action.path) || command || "files"}`;
  if (type === "search") {
    const query = nonEmptyString(action.query) || "";
    const target = nonEmptyString(action.path) || "workspace";
    return `search: ${query || command || "query"} in ${target}`;
  }
  return command || compactJson(value);
}

function formatFileChange(filePath: string, value: unknown) {
  const change = asRecord(value);
  const type = nonEmptyString(change?.type) || "change";
  const movePath = nonEmptyString(change?.move_path);
  if (type === "update" && movePath) return `update: ${filePath} -> ${movePath}`;
  return `${type}: ${filePath}`;
}

function describeApproval(request: unknown): ApprovalInfo {
  const rpc = asRecord(request) || {};
  const params = asRecord(rpc.params) || {};
  const method = nonEmptyString(rpc.method) || "approval";
  const raw = JSON.stringify(request, null, 2) || "";
  const reason = nonEmptyString(params.reason);
  const grantRoot = nonEmptyString(params.grantRoot);
  const cwd = nonEmptyString(params.cwd);
  const networkContext = asRecord(params.networkApprovalContext);
  const network = networkContext
    ? [nonEmptyString(networkContext.protocol), nonEmptyString(networkContext.host)].filter(Boolean).join("://")
    : undefined;

  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    const commandValue = params.command;
    const command = Array.isArray(commandValue) ? commandValue.map(String).join(" ") : nonEmptyString(commandValue);
    const actionValues = Array.isArray(params.commandActions)
      ? params.commandActions
      : Array.isArray(params.parsedCmd)
        ? params.parsedCmd
        : [];
    return {
      kind: "Command",
      title: "コマンド実行の承認",
      reason,
      command,
      cwd,
      network,
      grantRoot,
      permissions: params.additionalPermissions ? compactJson(params.additionalPermissions) : undefined,
      actions: actionValues.map(formatCommandAction),
      fileChanges: [],
      canAcceptForSession:
        approvalHasDecision(params, "acceptForSession") || Boolean(params.proposedExecpolicyAmendment) || Boolean(params.proposedNetworkPolicyAmendments),
      raw,
    };
  }

  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const fileChanges = asRecord(params.fileChanges);
    return {
      kind: "Files",
      title: "ファイル変更の承認",
      reason,
      cwd,
      grantRoot,
      actions: [],
      fileChanges: fileChanges ? Object.entries(fileChanges).map(([filePath, change]) => formatFileChange(filePath, change)) : [],
      canAcceptForSession: Boolean(grantRoot),
      raw,
    };
  }

  if (method === "item/permissions/requestApproval") {
    return {
      kind: "Permissions",
      title: "権限変更の承認",
      reason,
      cwd,
      permissions: params.permissions ? compactJson(params.permissions) : undefined,
      actions: [],
      fileChanges: [],
      canAcceptForSession: false,
      raw,
    };
  }

  return {
    kind: "Approval",
    title: method,
    reason,
    cwd,
    actions: [],
    fileChanges: [],
    canAcceptForSession: false,
    raw,
  };
}

function parseModelOption(item: Record<string, unknown>): ModelOption | null {
  const id = String(item.model || item.id || "");
  const label = String(item.displayName || item.model || item.id || "");
  if (!id || !label) return null;

  const parsedEfforts = Array.isArray(item.supportedReasoningEfforts)
    ? uniqueReasoningOptions(item.supportedReasoningEfforts.map(parseReasoningEffortOption).filter((option): option is ReasoningEffortOption => Boolean(option)))
    : [];
  const defaultReasoningEffort = isReasoningEffort(item.defaultReasoningEffort)
    ? item.defaultReasoningEffort
    : parsedEfforts[0]?.id || "medium";
  const supportedReasoningEfforts = parsedEfforts.length ? parsedEfforts : fallbackReasoningOptions;

  return {
    id,
    label,
    description: typeof item.description === "string" ? item.description : undefined,
    defaultReasoningEffort,
    supportedReasoningEfforts,
    inputModalities: Array.isArray(item.inputModalities)
      ? item.inputModalities.filter((value): value is string => typeof value === "string")
      : [],
    isDefault: Boolean(item.isDefault),
  };
}

function MessageText({ entry }: { entry: ChatEntry }) {
  if (entry.role === "status" || entry.role === "error") return entry.text;
  return (
    <ReactMarkdown components={markdownComponents} rehypePlugins={[rehypeSanitize]} remarkPlugins={[remarkGfm]}>
      {entry.text}
    </ReactMarkdown>
  );
}

function ApprovalDetails({ info }: { info: ApprovalInfo }) {
  return (
    <div className="approval-content">
      <div className="approval-heading">
        <span>{info.kind}</span>
        <strong>{info.title}</strong>
      </div>
      {info.reason && <p className="approval-reason">{info.reason}</p>}
      <div className="approval-grid">
        {info.cwd && (
          <div>
            <span>CWD</span>
            <code>{info.cwd}</code>
          </div>
        )}
        {info.network && (
          <div>
            <span>Network</span>
            <code>{info.network}</code>
          </div>
        )}
        {info.grantRoot && (
          <div>
            <span>Grant root</span>
            <code>{info.grantRoot}</code>
          </div>
        )}
      </div>
      {info.command && (
        <div className="approval-block">
          <span>Command</span>
          <pre>{info.command}</pre>
        </div>
      )}
      {info.actions.length > 0 && (
        <div className="approval-block">
          <span>Detected actions</span>
          <ul>
            {info.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
        </div>
      )}
      {info.fileChanges.length > 0 && (
        <div className="approval-block">
          <span>Files</span>
          <ul>
            {info.fileChanges.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        </div>
      )}
      {info.permissions && (
        <div className="approval-block">
          <span>Permissions</span>
          <pre>{info.permissions}</pre>
        </div>
      )}
      <details className="approval-raw">
        <summary>Raw request</summary>
        <pre>{info.raw}</pre>
      </details>
    </div>
  );
}

function App() {
  const [token] = useState(initialToken);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState(initialThread);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [runState, setRunState] = useState<RunState>(token ? "booting" : "error");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessModeId>("review");
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort>(isReasoningEffort(initialEffort) ? initialEffort : "medium");
  const [pendingApproval, setPendingApproval] = useState<unknown>(null);
  const [lastError, setLastError] = useState(token ? "" : "token がありません。");
  const wsRef = useRef<WebSocket | null>(null);
  const assistantIdRef = useRef<string>("");
  const logRef = useRef<HTMLDivElement | null>(null);

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId),
    [selectedThreadId, threads],
  );

  const filteredThreads = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) =>
      [thread.title, thread.cwd || "", thread.preview || "", thread.id].some((value) => value.toLowerCase().includes(query)),
    );
  }, [search, threads]);

  const currentTitle = selectedThread?.title || (selectedThreadId ? compactId(selectedThreadId) : "新しい thread");
  const selectedModelOption = useMemo(() => models.find((model) => model.id === selectedModel), [models, selectedModel]);
  const selectedEffortOptions = useMemo(
    () => selectedModelOption?.supportedReasoningEfforts || fallbackReasoningOptions,
    [selectedModelOption],
  );
  const selectedModelSupportsImage =
    !selectedModelOption || selectedModelOption.inputModalities.length === 0 || selectedModelOption.inputModalities.includes("image");
  const approvalInfo = useMemo(() => (pendingApproval === null ? null : describeApproval(pendingApproval)), [pendingApproval]);
  const modelOptions = useMemo(() => {
    if (!selectedModel || models.some((model) => model.id === selectedModel)) return models;
    return [
      {
        id: selectedModel,
        label: selectedModel,
        defaultReasoningEffort: selectedEffort,
        supportedReasoningEfforts: fallbackReasoningOptions,
        inputModalities: [],
        isDefault: false,
      },
      ...models,
    ];
  }, [models, selectedEffort, selectedModel]);

  const updateThreadUrl = useCallback((threadId: string) => {
    const next = new URL(window.location.href);
    next.searchParams.delete("token");
    if (threadId) next.searchParams.set("thread", threadId);
    else next.searchParams.delete("thread");
    window.history.replaceState(null, "", next);
  }, []);

  const appendEntry = useCallback((entry: ChatEntry) => {
    setMessages((current) => [...current, entry].slice(-180));
  }, []);

  const appendAssistantDelta = useCallback((delta: string) => {
    if (!delta) return;
    setMessages((current) => {
      const last = current[current.length - 1];
      if (last && last.role === "assistant" && last.id === assistantIdRef.current) {
        return current.map((entry) => (entry.id === last.id ? { ...entry, text: entry.text + delta } : entry));
      }
      const next = makeLocalEntry("assistant", delta);
      assistantIdRef.current = next.id;
      return [...current, next].slice(-180);
    });
  }, []);

  const loadThreads = useCallback(async () => {
    if (!token) return;
    try {
      const result = await apiGet<{ data: ThreadSummary[] }>("/api/threads", token);
      setThreads(result.data);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  }, [token]);

  const loadModels = useCallback(async () => {
    if (!token) return;
    try {
      const result = await apiGet<Record<string, unknown>>("/api/models", token);
      const raw = Array.isArray(result.data) ? result.data : [];
      const next = raw
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map(parseModelOption)
        .filter((item): item is ModelOption => Boolean(item))
        .slice(0, 30);
      setModels(next);
    } catch {
      setModels([]);
    }
  }, [token]);

  const connect = useCallback(
    (threadId: string) => {
      if (!token) {
        setRunState("error");
        setLastError("起動時に表示された token 付き URL から開いてください。");
        return;
      }

      wsRef.current?.close();
      assistantIdRef.current = "";
      setPendingApproval(null);
      setMessages([]);
      setRunState("connecting");
      setLastError("");

      const url = new URL("/bridge", window.location.href);
      url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", token);
      if (threadId) url.searchParams.set("thread", threadId);

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        setRunState("connecting");
      });

      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data) as BridgeServerMessage;
        if (msg.type === "ready") {
          setSelectedThreadId(msg.threadId);
          updateThreadUrl(msg.threadId);
          setMessages(msg.history);
          setRunState("ready");
          void loadThreads();
          return;
        }
        if (msg.type === "user") {
          assistantIdRef.current = "";
          appendEntry(msg.entry);
          setRunState("running");
          return;
        }
        if (msg.type === "assistantDelta") {
          appendAssistantDelta(msg.text);
          setRunState("streaming");
          return;
        }
        if (msg.type === "status") {
          appendEntry(msg.entry);
          return;
        }
        if (msg.type === "approval") {
          setPendingApproval(msg.request);
          setRunState("approval");
          return;
        }
        if (msg.type === "turn" && msg.status === "started") {
          setRunState("running");
          return;
        }
        if (msg.type === "turn" && msg.status === "completed") {
          assistantIdRef.current = "";
          setRunState("done");
          setPendingApproval(null);
          void loadThreads();
          return;
        }
        if (msg.type === "error") {
          appendEntry(msg.entry);
          setLastError(msg.entry.text);
          setRunState("error");
        }
      });

      ws.addEventListener("close", () => {
        setRunState((state) => (state === "error" ? "error" : "offline"));
      });

      ws.addEventListener("error", () => {
        setRunState("error");
        setLastError("WebSocket 接続に失敗しました。");
      });
    },
    [appendAssistantDelta, appendEntry, loadThreads, token, updateThreadUrl],
  );

  useEffect(() => {
    if (token) {
      localStorage.setItem("codexRemoteToken", token);
      const next = new URL(window.location.href);
      if (next.searchParams.has("token")) {
        next.searchParams.delete("token");
        window.history.replaceState(null, "", next);
      }
    }
  }, [token]);

  useEffect(() => {
    void apiGet<ServerInfo>("/api/info")
      .then((result) => {
        setInfo(result);
        setSelectedModel((current) => current || result.model);
      })
      .catch((error) => setLastError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    if (!token) return;
    void loadThreads();
    void loadModels();
    connect(initialThread);
    return () => wsRef.current?.close();
  }, [connect, loadModels, loadThreads, token]);

  useEffect(() => {
    if (!models.length) return;
    setSelectedModel((current) => {
      if (current && models.some((model) => model.id === current)) return current;
      return models.find((model) => model.isDefault)?.id || info?.model || models[0]?.id || current;
    });
  }, [info?.model, models]);

  useEffect(() => {
    setSelectedEffort((current) => {
      if (selectedEffortOptions.some((option) => option.id === current)) return current;
      const preferred = selectedModelOption?.defaultReasoningEffort;
      if (preferred && selectedEffortOptions.some((option) => option.id === preferred)) return preferred;
      return selectedEffortOptions[0]?.id || "medium";
    });
  }, [selectedEffortOptions, selectedModelOption]);

  useEffect(() => {
    if (selectedModel) localStorage.setItem("codexRemoteModel", selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    localStorage.setItem("codexRemoteEffort", selectedEffort);
  }, [selectedEffort]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const selectThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    updateThreadUrl(threadId);
    setDrawerOpen(false);
    connect(threadId);
  };

  const addAttachments = async (files: FileList | null, input: HTMLInputElement) => {
    input.value = "";
    if (!files || files.length === 0) return;
    if (!selectedModelSupportsImage) {
      setLastError("選択中の model は画像入力に対応していません。");
      return;
    }
    try {
      const remaining = maxImageAttachments - attachments.length;
      if (remaining <= 0) throw new Error(`画像添付は一度に ${maxImageAttachments} 件までです。`);
      const next = await Promise.all(Array.from(files).slice(0, remaining).map(fileToAttachment));
      setAttachments((current) => [...current, ...next].slice(0, maxImageAttachments));
      setLastError("");
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
    }
  };

  const sendPrompt = () => {
    const text = prompt.trim();
    const ws = wsRef.current;
    if ((!text && attachments.length === 0) || !ws || ws.readyState !== WebSocket.OPEN) return;
    const message: BridgeClientMessage = {
      type: "prompt",
      text,
      attachments,
      options: {
        accessMode,
        model: selectedModel || undefined,
        effort: selectedEffort,
      },
    };
    ws.send(JSON.stringify(message));
    setPrompt("");
    setAttachments([]);
  };

  const decideApproval = (decision: ApprovalDecision) => {
    const ws = wsRef.current;
    if (!pendingApproval || !ws || ws.readyState !== WebSocket.OPEN) return;
    const message: BridgeClientMessage = { type: "approval", decision, request: pendingApproval };
    ws.send(JSON.stringify(message));
    setPendingApproval(null);
    setRunState("running");
  };

  return (
    <main className="app-shell">
      <button
        className={`sidebar-scrim ${drawerOpen ? "visible" : ""}`}
        type="button"
        aria-label="サイドバーを閉じる"
        onClick={() => setDrawerOpen(false)}
      />

      <aside className={`sidebar ${drawerOpen ? "open" : ""}`} aria-label="Thread navigation">
        <div className="brand-row">
          <div>
            <div className="brand-mark">CR</div>
          </div>
          <div className="brand-copy">
            <strong>Codex Remote</strong>
            <span>{info?.workdir ? projectName(info.workdir) : "local bridge"}</span>
          </div>
          <button className="icon-button sidebar-close" type="button" onClick={() => setDrawerOpen(false)} aria-label="閉じる">
            <X size={18} />
          </button>
        </div>

        <button className="new-thread" type="button" onClick={() => selectThread("")}>
          <Plus size={17} />
          <span>新しい thread</span>
        </button>

        <label className="search-box">
          <span>検索</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="thread / project" />
        </label>

        <div className="thread-list" aria-label="Threads">
          {filteredThreads.map((thread) => (
            <button
              className={`thread-row ${thread.id === selectedThreadId ? "active" : ""}`}
              type="button"
              key={thread.id}
              onClick={() => selectThread(thread.id)}
            >
              <span className="thread-title">{thread.title}</span>
              <span className="thread-meta">
                {projectName(thread.cwd)}
                {thread.updatedAt ? ` · ${relativeTime(thread.updatedAt)}` : ""}
              </span>
            </button>
          ))}
          {filteredThreads.length === 0 && <div className="empty-list">thread なし</div>}
        </div>

        <div className="sidebar-status">
          <span className={`state-dot ${runState}`} />
          <span>{runStateLabel[runState]}</span>
        </div>
      </aside>

      <section className="workspace" aria-label="Codex conversation">
        <header className="topbar">
          <button className="icon-button sidebar-toggle" type="button" onClick={() => setDrawerOpen(true)} aria-label="サイドバー">
            <PanelLeft size={19} />
          </button>
          <div className="thread-heading">
            <h1>{currentTitle}</h1>
            <p>{info ? `${selectedModel || info.model} · Thinking ${reasoningLabels[selectedEffort]} · ${projectName(info.workdir)}` : "Codex app-server"}</p>
          </div>
          <div className="topbar-actions">
            <span className={`run-pill ${runState}`}>
              <span className="run-dot" />
              {runStateLabel[runState]}
            </span>
            <button className="icon-button" type="button" onClick={() => connect(selectedThreadId)} aria-label="再接続">
              <RefreshCcw size={17} />
            </button>
            <button className="icon-button mobile-menu" type="button" onClick={() => setDrawerOpen(true)} aria-label="メニュー">
              <Menu size={18} />
            </button>
          </div>
        </header>

        {lastError && (
          <div className="error-strip" role="alert">
            {lastError}
          </div>
        )}

        <div className="message-log" ref={logRef}>
          {messages.length === 0 && (
            <div className="empty-state">
              <Shield size={24} />
              <span>{runState === "connecting" ? "接続しています" : "Codex Remote"}</span>
            </div>
          )}
          {messages.map((entry) => (
            <article className={`message ${entry.role}`} key={entry.id}>
              <div className="message-role">{entry.role === "assistant" ? "Codex" : entry.role === "user" ? "You" : "System"}</div>
              <div className="message-body">
                <MessageText entry={entry} />
              </div>
            </article>
          ))}
        </div>

        {pendingApproval !== null && (
          <section className="approval-panel" aria-label="Approval request">
            {approvalInfo && <ApprovalDetails info={approvalInfo} />}
            <div className="approval-actions">
              <button type="button" className="secondary-button" onClick={() => decideApproval("decline")}>
                <X size={16} />
                拒否
              </button>
              {approvalInfo?.canAcceptForSession && (
                <button type="button" className="secondary-button" onClick={() => decideApproval("acceptForSession")}>
                  <Shield size={16} />
                  セッションで承認
                </button>
              )}
              <button type="button" className="primary-button" onClick={() => decideApproval("accept")}>
                <Check size={16} />
                今回だけ承認
              </button>
            </div>
          </section>
        )}

        <footer className="composer-shell">
          <div className="control-row">
            <div className="model-controls">
              <label className="select-control model-control">
                <span>Model</span>
                <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                  {modelOptions.map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </label>
              <label className="select-control effort-control">
                <span>Thinking</span>
                <select value={selectedEffort} onChange={(event) => setSelectedEffort(event.target.value as ReasoningEffort)}>
                  {selectedEffortOptions.map((option) => (
                    <option value={option.id} key={option.id} title={option.description}>
                      {reasoningLabels[option.id]}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </label>
            </div>
            <div className="access-tabs" aria-label="Access mode">
              {accessModes.map((mode) => (
                <button
                  type="button"
                  className={mode.id === accessMode ? "active" : ""}
                  key={mode.id}
                  onClick={() => setAccessMode(mode.id)}
                  title={mode.label}
                >
                  {mode.short}
                </button>
              ))}
            </div>
          </div>

          {attachments.length > 0 && (
            <div className="attachment-strip" aria-label="添付画像">
              {attachments.map((attachment) => (
                <div className="attachment-chip" key={attachment.id}>
                  <img src={attachment.dataUrl} alt="" />
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    aria-label={`${attachment.name} を削除`}
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  sendPrompt();
                }
              }}
              placeholder="Codex に送る"
              rows={3}
            />
            <label
              className={`attach-button ${!selectedModelSupportsImage ? "disabled" : ""}`}
              title={selectedModelSupportsImage ? "画像を添付" : "この model は画像入力に未対応です"}
            >
              <ImagePlus size={18} />
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                disabled={!selectedModelSupportsImage}
                onChange={(event) => void addAttachments(event.currentTarget.files, event.currentTarget)}
              />
            </label>
            <button className="send-button" type="button" onClick={sendPrompt} disabled={(!prompt.trim() && attachments.length === 0) || runState === "connecting"}>
              <Send size={18} />
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

export default App;
