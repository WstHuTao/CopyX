export type TestCase = {
  id: string;
  name: string;
  input: string;
  expected: string;
};
export type TestReport = {
  fingerprint: string;
  passed: boolean;
  total: number;
  message?: string;
  results: {
    id: string;
    passed: boolean;
    actual?: string;
    error?: string;
    elapsedMs: number;
  }[];
};
export type ScriptConversationView = {
  id: string;
  schemeId: string;
  modelId: string;
  turns: {
    role: "user" | "assistant";
    kind: "discussion" | "plan" | "confirmation" | "generation";
    content: string;
  }[];
  plan: { id: string; text: string } | null;
  context: { script: string; testCases: TestCase[] };
  generated: {
    script: string;
    report: TestReport;
    testCases: TestCase[];
  } | null;
  storageWarning: string | null;
};
export type ScriptContext = {
  schemeId: string;
  modelId: string;
  script: string;
  testCases: TestCase[];
};
export type ShortcutSettings = {
  enabled: boolean;
  shortcutMac: string;
  shortcutWin: string;
};
export type PromptEntry = {
  id: string;
  prompt: string;
  favorite: boolean;
  lastRun: { prompt: string; schemeId: string; modelId: string };
};
export type PromptUpdate = { id: string } & (
  | { action: "favorite"; favorite: boolean }
  | { action: "edit"; prompt: string }
  | { action: "delete" }
);
export const aiShortcutId = "ai-prompt-shortcut";
export const emptyShortcut: ShortcutSettings = {
  enabled: false,
  shortcutMac: "",
  shortcutWin: "",
};
export type Scheme = ShortcutSettings & {
  disabled?: boolean;
  id: string;
  name: string;
  kind: "script" | "ai";
  script: string;
  prompt: string;
  modelId?: string;
  testCases?: TestCase[];
  activeScript?: {
    script: string;
    testCases: TestCase[];
    status: "legacy" | "verified";
    fingerprint?: string;
    testedAt?: string;
    count?: number;
  };
};
export type Model = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasKey?: boolean;
  needsKeyUpdate?: boolean;
  apiKey?: string;
  clearKey?: boolean;
};
export type Config = {
  startupWarning?: string;
  schemaVersion?: number;
  schemes: Scheme[];
  models: Model[];
  aiShortcut?: ShortcutSettings;
  promptHistory?: PromptEntry[];
};
type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
export interface Desktop {
  platform: string;
  checkShortcut(value: {
    schemeId: string;
    key: string;
    schemes: Scheme[];
    aiShortcut?: ShortcutSettings;
    sharedAI?: boolean;
  }): Promise<Reply<{ available: boolean; message: string }>>;
  beginShortcutRecording(): Promise<Reply<void>>;
  endShortcutRecording(): Promise<Reply<void>>;
  getConfig(): Promise<Reply<Config>>;
  saveConfig(value: Config): Promise<Reply<Config>>;
  exportScheme(
    value: Pick<Scheme, "name" | "kind" | "script" | "prompt" | "testCases">,
  ): Promise<Reply<boolean>>;
  importScheme(): Promise<Reply<Scheme | null>>;
  run(value: {
    text: string;
    schemeId: string;
    prompt?: string;
  }): Promise<Reply<string>>;
  runPrompt(value: {
    text: string;
    schemeId: string;
    prompt?: string;
    latestPromptId?: string;
  }): Promise<
    Reply<{ text: string; history: PromptEntry[]; historyWarning?: string }>
  >;
  updatePromptHistory(value: PromptUpdate): Promise<Reply<PromptEntry[]>>;
  getScriptConversation(schemeId: string): Promise<
    Reply<{
      conversation: ScriptConversationView | null;
      storageWarning: string | null;
    }>
  >;
  discussScript(
    value: ScriptContext & {
      requestId: string;
      conversationId?: string;
      message: string;
    },
  ): Promise<Reply<ScriptConversationView>>;
  generateScript(
    value: ScriptContext & {
      requestId: string;
      conversationId: string;
      planId: string;
    },
  ): Promise<
    Reply<{
      script: string;
      report: TestReport;
      conversation: ScriptConversationView;
    }>
  >;
  cancelScriptGeneration(requestId: string): Promise<Reply<void>>;
  testScript(value: {
    requestId: string;
    schemeId: string;
    script: string;
    testCases: TestCase[];
  }): Promise<Reply<TestReport>>;
  cancelScriptTests(requestId: string): Promise<Reply<void>>;
  activateScript(value: {
    schemeId: string;
    fingerprint: string;
  }): Promise<Reply<Config>>;
  cancel(): Promise<Reply<void>>;
  copy(text: string): Promise<Reply<void>>;
  testModel(id: string): Promise<Reply<string>>;
  permission(): Promise<Reply<boolean>>;
  confirm?(message: string): Promise<Reply<boolean>>;
  onCapture(
    fn: (value: {
      text: string;
      schemeId: string;
      prompt?: string;
      latestPromptId?: string;
      promptNotice?: string;
    }) => void,
  ): () => void;
  onNotice(fn: (message: string) => void): () => void;
}
declare global {
  interface Window {
    desktop?: Desktop;
  }
}
export async function unwrap<T>(promise: Promise<Reply<T>>) {
  const reply = await promise;
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}

let confirmationPending = false;

export async function confirmAction(message: string) {
  const confirm = window.desktop?.confirm;
  if (!confirm) return window.confirm(message);
  if (confirmationPending) return false;
  confirmationPending = true;
  try {
    const reply = await confirm(message);
    return reply.ok && reply.data;
  } finally {
    confirmationPending = false;
  }
}
