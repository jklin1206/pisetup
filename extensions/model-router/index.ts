import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEvent,
  InputEvent,
  Model,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Model metadata — kept outside the LLM prompt. Only the routing logic reads it.
// ---------------------------------------------------------------------------

interface ModelProfile {
  /** Provider/model id as registered in Pi, e.g. "kimi-k2.6", "openai/gpt-5.5" */
  id: string;
  /** Human-friendly name */
  name: string;
  /** Max context window in tokens */
  contextWindow: number;
  /** Relative cost: "cheap" | "moderate" | "premium" */
  costTier: "cheap" | "moderate" | "premium";
  /** Relative speed: "fast" | "normal" | "slow" */
  speedTier: "fast" | "normal" | "slow";
  /** Task strengths. Overlap is fine. */
  strengths: string[];
  /** Language tags where this model excels: "en", "zh", "ja", etc. */
  languageStrength: string[];
  /** True if the model reliably supports tool calling / function calling */
  reliableToolUse: boolean;
  /** True if the model supports thinking/reasoning mode */
  hasThinking: boolean;
  /** Notes kept out of prompt — developer context */
  notes?: string;
}

/**
 * Edit this list when Pi provider names change or you add new models.
 * The `id` must match what Pi's model registry uses (provider/id or just id
 * if the provider is unambiguous).
 */
const MODEL_PROFILES: ModelProfile[] = [
  // OpenAI / Codex
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5 (Codex)",
    contextWindow: 1_000_000,
    costTier: "premium",
    speedTier: "normal",
    strengths: ["complex-edit", "debug", "multi-file", "architecture", "tool-call", "reliability"],
    languageStrength: ["en"],
    reliableToolUse: true,
    hasThinking: false,
    notes: "Best reliability for hard edits, debugging, multi-file changes. Expensive.",
  },
  {
    id: "openai/gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 1_000_000,
    costTier: "premium",
    speedTier: "normal",
    strengths: ["complex-edit", "debug", "multi-file", "architecture", "tool-call", "reliability"],
    languageStrength: ["en"],
    reliableToolUse: true,
    hasThinking: false,
    notes: "Slightly cheaper than 5.5; still best for hard tasks.",
  },
  {
    id: "openai/gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    contextWindow: 500_000,
    costTier: "premium",
    speedTier: "normal",
    strengths: ["complex-edit", "debug", "multi-file", "tool-call", "reliability"],
    languageStrength: ["en"],
    reliableToolUse: true,
    hasThinking: false,
  },
  // Kimi
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    contextWindow: 256_000,
    costTier: "moderate",
    speedTier: "normal",
    strengths: ["long-context", "coding", "bilingual", "devops"],
    languageStrength: ["zh", "en"],
    reliableToolUse: true,
    hasThinking: true,
    notes: "Excellent for long-horizon coding, Chinese-English mixed tasks.",
  },
  // GLM
  {
    id: "glm-5.1",
    name: "GLM-5.1",
    contextWindow: 200_000,
    costTier: "moderate",
    speedTier: "normal",
    strengths: ["long-context", "coding", "bilingual", "agentic-coding"],
    languageStrength: ["zh", "en"],
    reliableToolUse: true,
    hasThinking: true,
    notes: "Agentic coding optimised, Chinese-native workflows.",
  },
  // Qwen
  {
    id: "qwen/qwen3.6-plus",
    name: "Qwen3.6-Plus",
    contextWindow: 1_000_000,
    costTier: "moderate",
    speedTier: "fast",
    strengths: ["huge-context", "repo-scan", "frontend", "cheap-read", "bilingual"],
    languageStrength: ["zh", "en"],
    reliableToolUse: true,
    hasThinking: false,
    notes: "1M context, good for repo-level scans. Some tool-call error rate.",
  },
  // DeepSeek
  {
    id: "deepseek/deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    contextWindow: 1_000_000,
    costTier: "cheap",
    speedTier: "fast",
    strengths: ["huge-context", "cheap-read", "draft", "simple-edit"],
    languageStrength: ["zh", "en"],
    reliableToolUse: false,
    hasThinking: false,
    notes: "Cheapest 1M-context option. Use for drafts, scans, simple edits.",
  },
  {
    id: "deepseek/deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    contextWindow: 1_000_000,
    costTier: "moderate",
    speedTier: "normal",
    strengths: ["huge-context", "coding", "reasoning"],
    languageStrength: ["zh", "en"],
    reliableToolUse: true,
    hasThinking: false,
    notes: "Strong DeepSeek variant. Good coding + reasoning.",
  },
];

// ---------------------------------------------------------------------------
// Routing modes → which strengths to prioritise
// ---------------------------------------------------------------------------

type RoutingMode = "auto" | "cheap" | "fast" | "smart" | "long" | "cn" | "reliable";

const MODE_CONFIG: Record<RoutingMode, { label: string; description: string }> = {
  auto: { label: "Auto", description: "Detect from prompt content" },
  cheap: { label: "Cheap", description: "Minimise cost" },
  fast: { label: "Fast", description: "Minimise latency" },
  smart: { label: "Smart", description: "Max coding capability" },
  long: { label: "Long", description: "Long context / big files" },
  cn: { label: "CN", description: "Chinese / bilingual" },
  reliable: { label: "Reliable", description: "Tool-call reliability first" },
};

// ---------------------------------------------------------------------------
// Persisted state  (kept outside LLM context via session custom entries)
// ---------------------------------------------------------------------------

const ENTRY_TYPE = "model-router-state";

interface RouterState {
  enabled: boolean;
  mode: RoutingMode;
  pin: string | null;       // pinned model id
  repoDir: string | null;   // which repo the state belongs to
  overrides: Record<string, string>; // model → overridden-to
  rejected: number;          // how many times user rejected suggestion this session
}

const DEFAULT_STATE: RouterState = {
  enabled: false,
  mode: "auto",
  pin: null,
  repoDir: null,
  overrides: {},
  rejected: 0,
};

function loadState(ctx: ExtensionContext): RouterState {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
      try {
        return { ...DEFAULT_STATE, ...(entry.data as Partial<RouterState>) };
      } catch { /* corrupt entry, use defaults */ }
    }
  }
  return { ...DEFAULT_STATE, repoDir: ctx.cwd };
}

function saveState(pi: ExtensionAPI, state: RouterState) {
  pi.appendEntry(ENTRY_TYPE, state);
}

// ---------------------------------------------------------------------------
// Prompt scoring — runs on the raw user input to decide task shape
// ---------------------------------------------------------------------------

interface TaskSignals {
  /** Approximate token hint (very rough: char count / 4) */
  estimatedTokens: number;
  /** Does the prompt look like a complex implementation task? */
  isComplexEdit: boolean;
  /** Does the prompt ask for debugging? */
  isDebug: boolean;
  /** Does the prompt reference many files or a large codebase? */
  isBigContext: boolean;
  /** Contains Chinese characters? */
  hasChinese: boolean;
  /** Simple question or small edit? */
  isSimple: boolean;
  /** Architecture / design question? */
  isArchitecture: boolean;
  /** Ask for "cheap", "fast", "reliable" etc.? */
  userHint: RoutingMode | null;
}

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text);
}

function scorePrompt(text: string): TaskSignals {
  const lower = text.toLowerCase();
  const estimatedTokens = Math.ceil(text.length / 4);

  const complexKeywords = ["implement", "refactor", "migrate", "rewrite", "add support for", "build"];
  const debugKeywords = ["debug", "fix the bug", "why is", "failing", "error", "crash", "trace", "stack"];
  const bigContextKeywords = ["entire codebase", "whole repo", "all files", "@src/", "read all", "scan", "review the codebase"];
  const archKeywords = ["design", "architecture", "should i", "what's the best way", "trade-off", "tradeoff", "pattern"];

  const isComplexEdit = complexKeywords.some((k) => lower.includes(k));
  const isDebug = debugKeywords.some((k) => lower.includes(k));
  const isBigContext = bigContextKeywords.some((k) => lower.includes(k)) || estimatedTokens > 8000;
  const hasChinese = containsChinese(text);
  const isArchitecture = archKeywords.some((k) => lower.includes(k));

  // Simple if it's a short question / small change
  const isSimple = estimatedTokens < 500 && !isComplexEdit && !isDebug && !isBigContext;

  // Check for explicit user hints
  let userHint: RoutingMode | null = null;
  if (/cheap|low.?cost|save.?token/i.test(lower)) userHint = "cheap";
  else if (/fast|quick|speed|urgent|immediately/i.test(lower)) userHint = "fast";
  else if (/reliab|don.?t.?mess|don.?t.?break|careful|safely|production/i.test(lower)) userHint = "reliable";
  else if (/long.?context|big.?file|large.?codebase|whole.?repo/i.test(lower)) userHint = "long";
  else if (/chinese|中文|bilingual/i.test(lower)) userHint = "cn";
  else if (/smart|best.?model|hard|complex|tricky/i.test(lower)) userHint = "smart";

  return {
    estimatedTokens,
    isComplexEdit,
    isDebug,
    isBigContext,
    hasChinese,
    isSimple,
    isArchitecture,
    userHint,
  };
}

// ---------------------------------------------------------------------------
// Router — picks the best model for the current signals + mode
// ---------------------------------------------------------------------------

function resolveModelId(pi: ExtensionAPI, profile: ModelProfile): string | null {
  // Try exact match first (e.g. "openai/gpt-5.5")
  const exact = pi.modelRegistry.findAny(profile.id);
  if (exact) return profile.id;
  // Try by bare id (e.g. "gpt-5.5" if provider is implicit)
  const parts = profile.id.split("/");
  if (parts.length === 2) {
    const byId = pi.modelRegistry.find(parts[0], parts[1]);
    if (byId) return profile.id;
  }
  return null;
}

interface RouterResult {
  modelId: string;
  reason: string;
  alternatives: string[];
}

function route(
  pi: ExtensionAPI,
  signals: TaskSignals,
  mode: RoutingMode,
  pin: string | null,
  currentModel: Model | null,
): RouterResult | null {
  // If user has a pin, always use it
  if (pin) {
    const resolved = resolveModelId(pi, MODEL_PROFILES.find((p) => p.id === pin) ?? { id: pin, name: pin } as ModelProfile);
    if (resolved) return { modelId: resolved, reason: `Pinned: ${pin}`, alternatives: [] };
  }

  const available = MODEL_PROFILES
    .map((p) => ({ profile: p, available: resolveModelId(pi, p) }))
    .filter((x) => x.available !== null) as { profile: ModelProfile; available: string }[];

  if (available.length === 0) return null;

  // Effective mode
  const effectiveMode = signals.userHint ?? mode;

  let ranked: { profile: ModelProfile; available: string; score: number }[];

  switch (effectiveMode) {
    case "cheap":
      ranked = available.map((x) => ({
        ...x,
        score: (x.profile.costTier === "cheap" ? 30 : x.profile.costTier === "moderate" ? 20 : 0),
      }));
      break;
    case "fast":
      ranked = available.map((x) => ({
        ...x,
        score: (x.profile.speedTier === "fast" ? 30 : x.profile.speedTier === "normal" ? 15 : 5),
      }));
      break;
    case "smart":
      ranked = available.map((x) => ({
        ...x,
        score: (x.profile.reliableToolUse ? 20 : 0) + (x.profile.strengths.includes("complex-edit") ? 25 : 0) + (x.profile.strengths.includes("debug") ? 20 : 0) + (x.profile.costTier === "premium" ? 10 : 0),
      }));
      break;
    case "long":
      ranked = available.map((x) => ({
        ...x,
        score: (x.profile.contextWindow >= 500_000 ? 30 : x.profile.contextWindow >= 200_000 ? 15 : 0) + (x.profile.strengths.includes("huge-context") ? 25 : 0),
      }));
      break;
    case "cn":
      ranked = available.map((x) => ({
        ...x,
        score: (x.profile.languageStrength.includes("zh") ? 35 : 0) + (x.profile.strengths.includes("bilingual") ? 20 : 0),
      }));
      break;
    case "reliable":
      ranked = available.map((x) => ({
        ...x,
        score: (x.profile.reliableToolUse ? 40 : 0) + (x.profile.strengths.includes("reliability") ? 25 : 0) + (x.profile.costTier === "premium" ? 10 : 0),
      }));
      break;
    default: // auto — derive from signals
      ranked = available.map((x) => {
        let score = 0;
        if (signals.isComplexEdit || signals.isArchitecture) {
          score += x.profile.strengths.includes("complex-edit") ? 25 : 0;
          score += x.profile.strengths.includes("architecture") ? 20 : 0;
          score += x.profile.strengths.includes("multi-file") ? 15 : 0;
        }
        if (signals.isDebug) {
          score += x.profile.strengths.includes("debug") ? 25 : 0;
          score += x.profile.reliableToolUse ? 10 : 0;
        }
        if (signals.isBigContext) {
          score += x.profile.contextWindow >= 500_000 ? 25 : 10;
          score += x.profile.strengths.includes("huge-context") ? 20 : 0;
        }
        if (signals.hasChinese) {
          score += x.profile.languageStrength.includes("zh") ? 30 : 0;
        }
        if (signals.isSimple) {
          score += x.profile.costTier === "cheap" ? 15 : x.profile.costTier === "moderate" ? 10 : 0;
        }
        // Reliability baseline
        if (x.profile.reliableToolUse) score += 8;
        return { ...x, score };
      });
  }

  ranked.sort((a, b) => b.score - a.score);
  const winner = ranked[0];

  // Don't recommend switching if current model is already a good fit
  const currentId = currentModel ? `${currentModel.provider}/${currentModel.id}` : currentModel?.id ?? null;
  if (currentId && currentId === winner.available) return null;

  const alternatives = ranked.slice(1, 3).map((r) => r.profile.name);

  return {
    modelId: winner.available,
    reason: buildReason(winner.profile, effectiveMode, signals),
    alternatives,
  };
}

function buildReason(profile: ModelProfile, mode: RoutingMode, signals: TaskSignals): string {
  const reasons: string[] = [];
  if (profile.contextWindow >= 500_000) reasons.push(`${(profile.contextWindow / 1000).toFixed(0)}K context`);
  if (profile.costTier === "cheap") reasons.push("low cost");
  if (profile.reliableToolUse) reasons.push("reliable tool calling");
  if (profile.languageStrength.includes("zh")) reasons.push("Chinese-strong");
  if (signals.hasChinese) reasons.push("prompt contains Chinese");
  if (signals.isBigContext) reasons.push("large context expected");
  if (signals.isComplexEdit) reasons.push("complex edit");
  if (signals.isDebug) reasons.push("debugging task");

  return `${profile.name} — ${MODE_CONFIG[mode].label} mode: ${reasons.length > 0 ? reasons.join(", ") : "best match for signals"}`;
}

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

function renderBox(lines: string[], accentColor: string): string {
  const width = Math.max(50, ...lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length)) + 4;
  const border = `${accentColor}${"─".repeat(width)}${RESET}`;
  const padded = lines.map((l) => {
    const pad = width - l.replace(/\x1b\[[0-9;]*m/g, "").length - 2;
    return `${accentColor}│${RESET} ${l}${" ".repeat(Math.max(0, pad))}${accentColor}│${RESET}`;
  });
  return ["", border, ...padded, border, ""].join("\n");
}

function renderRecommendation(result: RouterResult, currentModel: Model | null, state: RouterState): string {
  const currentStr = currentModel ? `${currentModel.provider}/${currentModel.id}` : "unknown";
  const lines = [
    `${BOLD}${CYAN}MODEL ROUTER${RESET}  mode: ${state.mode}  |  pin: ${state.pin ?? "none"}`,
    "",
    `${BOLD}${GREEN}→ Switch to:${RESET} ${BOLD}${result.modelId}${RESET}`,
    `${DIM}${result.reason}${RESET}`,
    result.alternatives.length > 0
      ? `${DIM}Also good:${RESET} ${result.alternatives.join(", ")}`
      : "",
    "",
    `${DIM}Current: ${currentStr}${RESET}`,
    `${DIM}Press Enter to switch, Esc to keep current model.${RESET}`,
  ].filter(Boolean);
  return renderBox(lines, CYAN);
}

function renderStatus(state: RouterState, currentModel: Model | null, profiles: { id: string; name: string }[]): string {
  const currentId = currentModel ? `${currentModel.provider}/${currentModel.id}` : "unknown";
  const currentProfile = MODEL_PROFILES.find((p) => p.id === currentId);
  const lines = [
    `${BOLD}${CYAN}MODEL ROUTER STATUS${RESET}`,
    "",
    `Enabled:  ${state.enabled ? `${GREEN}yes${RESET}` : `${RED}no${RESET}`}`,
    `Mode:     ${state.mode} (${MODE_CONFIG[state.mode].label})`,
    `Pin:      ${state.pin ?? "none"}`,
    `Current:  ${currentId}${currentProfile ? ` (${currentProfile.name})` : ""}`,
    `Rejected: ${state.rejected} this session`,
    "",
    `${DIM}Available profiles:${RESET}`,
    ...profiles.map((p) => `  ${p.id}${p.name !== p.id ? ` (${p.name})` : ""}`),
    "",
    `${DIM}Commands: /route, /route on|off, /route mode <mode>, /route pin <id>, /route unpin${RESET}`,
  ];
  return renderBox(lines, CYAN);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let state: RouterState;

  pi.on("session_start", (_event, ctx) => {
    state = loadState(ctx);
  });

  // --------------- /route command ---------------

  pi.registerCommand("route", {
    description: "Model router — recommend or switch models based on task shape",
    handler: async (args: string, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (!sub || sub === "status" || sub === "") {
        // Show recommendation for current state
        const currentModel = ctx.model;
        const profiles = MODEL_PROFILES.map((p) => ({ id: p.id, name: p.name }));
        ctx.ui.notify(renderStatus(state, currentModel, profiles), "info");
        return;
      }

      if (sub === "on") {
        state.enabled = true;
        saveState(pi, state);
        ctx.ui.notify(`${BOLD}${GREEN}Model router enabled.${RESET} Will suggest model at task start.`, "success");
        return;
      }

      if (sub === "off") {
        state.enabled = false;
        saveState(pi, state);
        ctx.ui.notify(`${BOLD}${YELLOW}Model router disabled.${RESET}`, "info");
        return;
      }

      if (sub === "mode") {
        const mode = parts[1]?.toLowerCase() as RoutingMode | undefined;
        if (!mode || !MODE_CONFIG[mode]) {
          const modes = Object.keys(MODE_CONFIG).join(", ");
          ctx.ui.notify(`Usage: /route mode <${modes}>`, "error");
          return;
        }
        state.mode = mode;
        saveState(pi, state);
        ctx.ui.notify(`${BOLD}${GREEN}Mode → ${mode}${RESET} (${MODE_CONFIG[mode].description})`, "success");
        return;
      }

      if (sub === "pin") {
        const modelId = parts.slice(1).join(" ");
        if (!modelId) {
          ctx.ui.notify("Usage: /route pin <model-id>", "error");
          return;
        }
        state.pin = modelId;
        saveState(pi, state);
        ctx.ui.notify(`${BOLD}${GREEN}Pinned → ${modelId}${RESET}`, "success");
        return;
      }

      if (sub === "unpin") {
        state.pin = null;
        saveState(pi, state);
        ctx.ui.notify(`${BOLD}${YELLOW}Pin removed.${RESET}`, "info");
        return;
      }

      if (sub === "suggest" || sub === "recommend") {
        // Manual recommendation — evaluate and show
        const prompt = parts.slice(1).join(" ");
        const signals = scorePrompt(prompt || "general coding task");
        const result = route(pi, signals, state.mode, state.pin, ctx.model);
        if (!result) {
          ctx.ui.notify(`${BOLD}Current model is already optimal.${RESET}`, "info");
          return;
        }
        ctx.ui.notify(renderRecommendation(result, ctx.model, state), "info");
        // Ask user to confirm switch
        const ok = await ctx.ui.confirm(
          `Switch to ${result.modelId}?`,
          result.reason,
        );
        if (ok) {
          const model = pi.modelRegistry.findAny(result.modelId);
          if (model) {
            const success = await pi.setModel(model);
            if (success) {
              ctx.ui.notify(`${BOLD}${GREEN}Switched to ${result.modelId}${RESET}`, "success");
            } else {
              ctx.ui.notify(`Could not switch — no API key for ${result.modelId}`, "error");
            }
          } else {
            ctx.ui.notify(`Model ${result.modelId} not found in registry`, "error");
          }
        } else {
          state.rejected++;
          saveState(pi, state);
        }
        return;
      }

      // Fallback — treat args as a prompt to score
      const signals = scorePrompt(args);
      const result = route(pi, signals, state.mode, state.pin, ctx.model);
      if (!result) {
        ctx.ui.notify(`${BOLD}Current model is already optimal.${RESET}`, "info");
        return;
      }
      ctx.ui.notify(renderRecommendation(result, ctx.model, state), "info");
    },
  });

  // --------------- Auto-suggest on task start ---------------

  pi.on("input", async (event, ctx) => {
    if (!state.enabled) return;
    if (event.source !== "interactive" && event.source !== "rpc") return;
    // Don't route commands
    if (event.text.startsWith("/")) return;

    const signals = scorePrompt(event.text);
    const result = route(pi, signals, state.mode, state.pin, ctx.model);
    if (!result) return;

    // Don't nag if user rejected recently
    if (state.rejected >= 2) return;

    // Inject a system note that recommends switching — but do it via a custom
    // message so the LLM sees the suggestion without blowing context.
    // Actually, better: show a UI notification + offer to switch.
    if (!ctx.hasUI) return;

    // Use a non-blocking notification — the user can manually /route if they want.
    // Don't interrupt the current turn.
    ctx.ui.setStatus("model-router", `💡 ${result.modelId}`);
  });

  // --------------- before_agent_start: inject routing context note ---------------

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled) return;

    const signals = scorePrompt(event.prompt);
    const result = route(pi, signals, state.mode, state.pin, ctx.model);
    if (!result) return;
    if (state.rejected >= 2) return;

    // Inject a tiny one-line system note — minimal context impact.
    // The LLM can use it to justify model choice or remind the user.
    const note = `[model-router: suggested ${result.modelId} for this task — ${result.reason}]`;

    return {
      message: {
        customType: "model-router-suggestion",
        content: note,
        display: false, // don't show in TUI
      },
    };
  });
}
