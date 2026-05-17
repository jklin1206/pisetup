import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = path.join(os.homedir(), ".pi", "agent", "herd");
const RUNS = path.join(ROOT, "runs");
const STATE_PATH = path.join(ROOT, "state.json");
const DEFAULT_SESSION = "pi";
const DEFAULT_LINES = 80;

type Role = "scout" | "researcher" | "planner" | "reviewer" | "worker";

type HerdRun = {
  id: string;
  name: string;
  role: Role;
  task: string;
  cwd: string;
  session: string;
  workspaceId?: string;
  agentName: string;
  runDir: string;
  promptPath: string;
  systemPath: string;
  handoffPath: string;
  createdAt: string;
  model: string | null;
};

type HerdState = {
  session: string;
  workspaceId?: string;
  workspaceLabel?: string;
  runs: HerdRun[];
};

const ROLE_MODELS: Record<Role, string | null> = {
  scout: "opencode-go/deepseek-v4-flash",
  researcher: "opencode-go/kimi-k2.6",
  planner: "opencode-go/glm-5.1",
  reviewer: "opencode-go/glm-5.1",
  worker: null,
};

const ROLE_PROMPTS: Record<Role, string> = {
  scout: "You are a visible Herd scout running in your own Pi terminal. Map relevant context quickly. Read narrowly. Do not edit project files. Write a concise handoff with file paths, risks, and next questions.",
  researcher: "You are a visible Herd researcher running in your own Pi terminal. Research using primary sources and local constraints. Do not edit project files. Write a concise sourced brief with confidence and gaps.",
  planner: "You are a visible Herd planner running in your own Pi terminal. Create a concrete implementation plan with files, validation, risks, and open decisions. Do not edit project files.",
  reviewer: "You are a visible Herd reviewer running in your own Pi terminal. Review actual files/diffs directly. Report severity-ranked findings with evidence. Do not edit unless explicitly asked.",
  worker: "You are a visible Herd worker running in your own Pi terminal. Implement only the requested scope. Make focused changes, validate, and write a handoff with changed files, commands, results, and unresolved items.",
};

const ROLE_ALIASES: Record<string, Role> = {
  scout: "scout",
  research: "researcher",
  researcher: "researcher",
  plan: "planner",
  planner: "planner",
  review: "reviewer",
  reviewer: "reviewer",
  worker: "worker",
  work: "worker",
  implement: "worker",
};

function id() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function quote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function splitArgs(input: string) {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function execFile(command: string, args: string[], opts: { timeout?: number; cwd?: string } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawnChild(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeout ? setTimeout(() => child.kill("SIGTERM"), opts.timeout) : null;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
  });
}

async function herdrInstalled() {
  const result = await execFile("bash", ["-lc", "command -v herdr"], { timeout: 5_000 });
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function loadState(): Promise<HerdState> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as HerdState;
    return { session: parsed.session || DEFAULT_SESSION, workspaceId: parsed.workspaceId, workspaceLabel: parsed.workspaceLabel, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
  } catch {
    return { session: DEFAULT_SESSION, runs: [] };
  }
}

async function saveState(state: HerdState) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function herdr(session: string, args: string[], opts: { timeout?: number; cwd?: string } = {}) {
  return execFile("herdr", ["--session", session, ...args], opts);
}

function parseJson<T = any>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

async function openHerdr(session: string, cwd: string) {
  const safeSession = session.replace(/[^a-zA-Z0-9._-]/g, "") || DEFAULT_SESSION;
  const cmuxPath = await execFile("bash", ["-lc", "command -v cmux"], { timeout: 5_000 });
  if (cmuxPath.code === 0 && cmuxPath.stdout.trim()) {
    const result = await execFile("cmux", [
      "new-workspace",
      "--name", `Herd ${safeSession}`,
      "--cwd", cwd,
      "--command", `herdr --session ${safeSession}`,
      "--focus", "true",
    ], { timeout: 15_000 });
    if (result.code === 0) return `Opened cmux workspace: Herd ${safeSession}`;
  }

  if (process.platform !== "darwin") return "Open manually: herdr --session " + safeSession;
  const script = `tell application "Terminal"\n  activate\n  do script "herdr --session ${safeSession} "\nend tell`;
  const result = await execFile("osascript", ["-e", script], { timeout: 10_000 });
  if (result.code !== 0) return `Open manually: herdr --session ${safeSession}`;
  return `Opened Terminal with: herdr --session ${safeSession}`;
}

async function ensureHerdrReady(session: string, open: boolean, cwd = process.cwd()) {
  if (!(await herdrInstalled())) {
    throw new Error("Herdr is not installed. Run `/herd install` if you want the official installer, or install from https://github.com/ogulcancelik/herdr.");
  }

  // The integration install is intended to be idempotent; if it fails, do not block raw pane management.
  await execFile("herdr", ["integration", "install", "pi"], { timeout: 20_000 });

  let opened = "";
  if (open) opened = await openHerdr(session, cwd);
  return opened;
}

async function boot(args: string, cwd: string) {
  const tokens = splitArgs(args);
  const sessionFlag = tokens.findIndex((t) => t === "--session" || t === "-s");
  const labelFlag = tokens.findIndex((t) => t === "--label" || t === "-l");
  const noOpen = tokens.includes("--no-open");
  const session = sessionFlag >= 0 ? tokens[sessionFlag + 1] || DEFAULT_SESSION : DEFAULT_SESSION;
  const label = labelFlag >= 0 ? tokens[labelFlag + 1] || path.basename(cwd) : path.basename(cwd) || "work";

  const opened = await ensureHerdrReady(session, !noOpen, cwd);
  await new Promise((resolve) => setTimeout(resolve, noOpen ? 0 : 1_000));

  const state = await loadState();
  state.session = session;

  let workspaceId = state.workspaceId;
  if (!workspaceId) {
    const created = await herdr(session, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"], { timeout: 15_000 });
    if (created.code !== 0) {
      throw new Error(`Herdr workspace create failed. ${created.stderr || created.stdout || "Try opening Herdr first with: herdr --session " + session}`);
    }
    const parsed = parseJson<any>(created.stdout);
    workspaceId = parsed?.result?.workspace?.workspace_id ?? parsed?.workspace?.workspace_id;
  }

  state.workspaceId = workspaceId;
  state.workspaceLabel = label;
  await saveState(state);
  return `Herd booted.\nSession: ${session}\nWorkspace: ${workspaceId ?? "unknown"} (${label})\n${opened || `Attach: herdr --session ${session}`}\n\nStart a visible worker: /herd scout "map this repo"`;
}

async function start(role: Role, task: string, cwd: string, extraArgs: string) {
  if (!task.trim()) throw new Error(`Usage: /herd ${role} "task"`);
  const state = await loadState();
  await ensureHerdrReady(state.session, false, cwd);

  if (!state.workspaceId) {
    const booted = await boot("--no-open", cwd);
    const reloaded = await loadState();
    state.workspaceId = reloaded.workspaceId;
    state.workspaceLabel = reloaded.workspaceLabel;
    if (!state.workspaceId) throw new Error(`Could not create Herdr workspace. ${booted}`);
  }

  const runId = id();
  const name = `h-${role}-${runId}`.slice(0, 48);
  const runDir = path.join(RUNS, runId);
  await mkdir(runDir, { recursive: true });
  const handoffPath = path.join(runDir, "handoff.md");
  const systemPath = path.join(runDir, "system.md");
  const promptPath = path.join(runDir, "prompt.md");
  const model = extraArgs.includes("--current") ? null : ROLE_MODELS[role];

  await writeFile(systemPath, `${ROLE_PROMPTS[role]}\n\nYou are visible in Herdr. The parent agent/user may inspect, attach, interrupt, or wait on your terminal. Always write your final handoff to ${handoffPath}.\n`);
  await writeFile(promptPath, `# Herd ${role}\n\nTask:\n${task}\n\nWorking directory:\n${cwd}\n\nRequired final handoff path:\n${handoffPath}\n`);
  await writeFile(handoffPath, `# Herd handoff: ${role}\n\nStatus: running\n\nTask: ${task}\n`);

  const command = [
    "cd", quote(cwd), "|| exit 1;",
    `SYSTEM_PROMPT=$(cat ${quote(systemPath)});`,
    "pi",
    model ? `--model ${quote(model)}` : "",
    "--append-system-prompt \"$SYSTEM_PROMPT\"",
    quote(`@${promptPath}`),
  ].filter(Boolean).join(" ");

  const result = await herdr(state.session, [
    "agent", "start", name,
    "--cwd", cwd,
    "--workspace", state.workspaceId,
    "--split", "right",
    "--no-focus",
    "--",
    "bash", "-lc", command,
  ], { timeout: 20_000 });

  if (result.code !== 0) throw new Error(`Herdr agent start failed: ${result.stderr || result.stdout}`);

  const run: HerdRun = {
    id: runId,
    name,
    role,
    task,
    cwd,
    session: state.session,
    workspaceId: state.workspaceId,
    agentName: name,
    runDir,
    promptPath,
    systemPath,
    handoffPath,
    createdAt: new Date().toISOString(),
    model,
  };
  state.runs = [run, ...state.runs].slice(0, 100);
  await saveState(state);
  return `Started Herd ${role}.\nName: ${name}\nSession: ${state.session}\nWorkspace: ${state.workspaceId}\nModel: ${model ?? "current/default"}\nRead: /herd read ${name}\nWait: /herd wait ${name}\nAttach: herdr --session ${state.session} agent attach ${name}\nHandoff: ${handoffPath}`;
}

async function list() {
  const state = await loadState();
  if (!(await herdrInstalled())) return "Herdr is not installed.";
  const agents = await herdr(state.session, ["agent", "list"], { timeout: 10_000 });
  const local = state.runs.slice(0, 12).map((r) => `- ${r.name} ${r.role} ${r.model ?? "current"}\n  task: ${r.task.slice(0, 100)}\n  handoff: ${r.handoffPath}`).join("\n");
  return `Session: ${state.session}\nWorkspace: ${state.workspaceId ?? "none"}\n\nHerdr agents:\n${agents.stdout.trim() || agents.stderr.trim() || "none"}\n\nTracked Herd runs:\n${local || "none"}`;
}

async function readTarget(target: string, lines = DEFAULT_LINES) {
  const state = await loadState();
  if (!target) throw new Error("Usage: /herd read <agent-or-pane> [lines]");
  const result = await herdr(state.session, ["agent", "read", target, "--source", "recent-unwrapped", "--lines", String(lines)], { timeout: 10_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Read failed");
  return result.stdout.trim() || "No output.";
}

async function waitTarget(target: string, timeoutMs: string | undefined) {
  const state = await loadState();
  if (!target) throw new Error("Usage: /herd wait <agent-or-pane> [timeout-ms]");
  const timeout = timeoutMs && /^\d+$/.test(timeoutMs) ? timeoutMs : "600000";
  const result = await herdr(state.session, ["agent", "wait", target, "--status", "idle", "--timeout", timeout], { timeout: Number(timeout) + 5_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Wait failed");
  const transcript = await readTarget(target, DEFAULT_LINES).catch((error) => `Could not read transcript: ${String(error)}`);
  const stateNow = await loadState();
  const run = stateNow.runs.find((r) => r.name === target || r.id === target);
  let handoff = "";
  if (run && existsSync(run.handoffPath)) handoff = await readFile(run.handoffPath, "utf8").catch(() => "");
  return `Herd target idle: ${target}\n\n${handoff ? `Handoff:\n${handoff}\n\n` : ""}Recent output:\n${transcript}`;
}

async function installHerdr() {
  if (await herdrInstalled()) return "Herdr is already installed.";
  const result = await execFile("bash", ["-lc", "curl -fsSL https://herdr.dev/install.sh | sh"], { timeout: 120_000 });
  if (result.code !== 0) throw new Error(`Herdr install failed: ${result.stderr || result.stdout}`);
  return `Herdr install command completed.\n${result.stdout.trim() || result.stderr.trim()}\n\nNext: /herd boot`;
}

function help() {
  return `Herd commands:\n/herd boot                 Open/prepare Herdr session + workspace\n/herd boot --no-open       Prepare without opening Terminal\n/herd scout "task"         Start visible scout Pi worker\n/herd research "task"      Start visible researcher\n/herd plan "task"          Start visible planner\n/herd review "task"        Start visible reviewer\n/herd worker "task"        Start visible implementation worker\n/herd list                 Show Herdr agents + tracked runs\n/herd read <name> [lines]  Read recent output\n/herd wait <name> [ms]     Wait until idle, then read output/handoff\n/herd attach <name>        Show direct attach command\n/herd install              Run official Herdr installer`;
}

async function handle(input: string, cwd: string) {
  const trimmed = input.replace(/^\/?herd\b/i, "").trim();
  const [cmdRaw = "help", ...rest] = splitArgs(trimmed);
  const cmd = cmdRaw.toLowerCase();
  const restText = trimmed.slice(cmdRaw.length).trim();

  if (cmd === "help") return help();
  if (cmd === "install") return installHerdr();
  if (cmd === "boot" || cmd === "open") return boot(restText, cwd);
  if (cmd === "list" || cmd === "ls" || cmd === "status") return list();
  if (cmd === "read") return readTarget(rest[0] || "", rest[1] ? Number(rest[1]) : DEFAULT_LINES);
  if (cmd === "wait") return waitTarget(rest[0] || "", rest[1]);
  if (cmd === "attach") {
    const state = await loadState();
    const target = rest[0];
    if (!target) throw new Error("Usage: /herd attach <agent-or-pane>");
    return `Attach directly:\nherdr --session ${state.session} agent attach ${target}\n\nFull cockpit:\nherdr --session ${state.session}`;
  }

  const role = ROLE_ALIASES[cmd];
  if (role) return start(role, restText, cwd, restText);

  return help();
}

export default function herdExtension(pi: ExtensionAPI) {
  pi.registerCommand("herd", {
    description: "Boot and manage visible Herdr-backed Pi workers",
    getArgumentCompletions: (prefix) => {
      const values = ["boot", "scout", "research", "plan", "review", "worker", "list", "read", "wait", "attach", "install", "help"];
      return values.filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      try {
        const result = await handle(`herd ${args}`, ctx.cwd || process.cwd());
        ctx.ui.notify(result, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (!/^(?:\/)?herd\b/i.test(event.text.trim())) return { action: "continue" };
    try {
      const result = await handle(event.text, ctx.cwd || process.cwd());
      ctx.ui.notify(result, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
    return { action: "handled" };
  });
}
