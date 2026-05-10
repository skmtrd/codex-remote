export type RunState =
  | "booting"
  | "connecting"
  | "ready"
  | "running"
  | "streaming"
  | "approval"
  | "done"
  | "offline"
  | "error";

export type ChatRole = "user" | "assistant" | "status" | "error";

export type ChatEntry = {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
};

export type ThreadSummary = {
  id: string;
  title: string;
  cwd?: string;
  updatedAt?: number;
  preview?: string;
};

export type ServerInfo = {
  model: string;
  workdir: string;
  uiPort: number;
  codexEndpoint: string;
  managedCodexServer: boolean;
  tokenRequired: boolean;
};

export type AccessModeId = "full" | "review" | "read-only";

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type PromptOptions = {
  model?: string;
  effort?: ReasoningEffort;
  accessMode: AccessModeId;
};

export type PromptAttachment = {
  id: string;
  name: string;
  mediaType: string;
  dataUrl: string;
};

export type BridgeClientMessage =
  | {
      type: "prompt";
      text: string;
      attachments?: PromptAttachment[];
      options: PromptOptions;
    }
  | {
      type: "approval";
      decision: ApprovalDecision;
      request: unknown;
    };

export type BridgeServerMessage =
  | {
      type: "ready";
      threadId: string;
      model: string;
      workdir: string;
      clients: number;
      history: ChatEntry[];
    }
  | {
      type: "user";
      entry: ChatEntry;
    }
  | {
      type: "assistantDelta";
      text: string;
    }
  | {
      type: "status";
      entry: ChatEntry;
    }
  | {
      type: "approval";
      request: unknown;
    }
  | {
      type: "turn";
      status: "started" | "completed";
      turnId?: string;
    }
  | {
      type: "error";
      entry: ChatEntry;
    };

export function newEntry(role: ChatRole, text: string): ChatEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role,
    text,
    createdAt: Date.now(),
  };
}
