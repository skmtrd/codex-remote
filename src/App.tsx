import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Menu,
  PanelLeft,
  Plus,
  RefreshCcw,
  Send,
  Shield,
  X,
} from "lucide-react";
import type {
  AccessModeId,
  BridgeClientMessage,
  BridgeServerMessage,
  ChatEntry,
  RunState,
  ServerInfo,
  ThreadSummary,
} from "../shared/protocol.js";
import "./App.css";

type ModelOption = {
  id: string;
  label: string;
};

const initialParams = new URLSearchParams(window.location.search);
const initialToken = initialParams.get("token") || localStorage.getItem("codexRemoteToken") || "";
const initialThread = initialParams.get("thread") || "";

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

function App() {
  const [token] = useState(initialToken);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState(initialThread);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [prompt, setPrompt] = useState("");
  const [search, setSearch] = useState("");
  const [runState, setRunState] = useState<RunState>(token ? "booting" : "error");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessModeId>("review");
  const [selectedModel, setSelectedModel] = useState("");
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
        .map((item) => ({
          id: String(item.model || item.id || ""),
          label: String(item.displayName || item.model || item.id || ""),
        }))
        .filter((item) => item.id && item.label)
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
        setSelectedModel(result.model);
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
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const selectThread = (threadId: string) => {
    setSelectedThreadId(threadId);
    updateThreadUrl(threadId);
    setDrawerOpen(false);
    connect(threadId);
  };

  const sendPrompt = () => {
    const text = prompt.trim();
    const ws = wsRef.current;
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    const message: BridgeClientMessage = {
      type: "prompt",
      text,
      options: {
        accessMode,
        model: selectedModel || undefined,
      },
    };
    ws.send(JSON.stringify(message));
    setPrompt("");
  };

  const decideApproval = (decision: "accept" | "decline") => {
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
            <p>{info ? `${info.model} · ${projectName(info.workdir)}` : "Codex app-server"}</p>
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
              <div className="message-body">{entry.text}</div>
            </article>
          ))}
        </div>

        {pendingApproval !== null && (
          <section className="approval-panel" aria-label="Approval request">
            <div>
              <strong>承認リクエスト</strong>
              <pre>{JSON.stringify(pendingApproval, null, 2) || ""}</pre>
            </div>
            <div className="approval-actions">
              <button type="button" className="secondary-button" onClick={() => decideApproval("decline")}>
                <X size={16} />
                拒否
              </button>
              <button type="button" className="primary-button" onClick={() => decideApproval("accept")}>
                <Check size={16} />
                承認
              </button>
            </div>
          </section>
        )}

        <footer className="composer-shell">
          <div className="control-row">
            <label className="select-control">
              <span>Model</span>
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                {selectedModel && <option value={selectedModel}>{selectedModel}</option>}
                {models
                  .filter((model) => model.id !== selectedModel)
                  .map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.label}
                    </option>
                  ))}
              </select>
              <ChevronDown size={15} />
            </label>
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
            <button className="send-button" type="button" onClick={sendPrompt} disabled={!prompt.trim() || runState === "connecting"}>
              <Send size={18} />
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

export default App;
