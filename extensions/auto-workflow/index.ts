import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".pi", "agent", "auto-workflow");
const DEFAULT_MAX_FIX_LOOPS = 2;
const MAX_LOG_CHARS = 40_000;
const REVIEW_OK_MARKER = "AUTO_WORKFLOW_REVIEW_OK";

type Phase =
  | "idle"
  | "implementing"
  | "testing_after_implement"
  | "reviewing"
  | "fixing"
  | "testing_after_fix"
  | "verifying"
  | "done"
  | "failed";

type WorkflowState = {
  active: boolean;
  id: string;
  task: string;
  cwd: string;
  phase: Phase;
  testCommands: string[];
  fixLoops: number;
  maxFixLoops: number;
  askUserBeforeFix: boolean;
  logs: Array<{ at: string; phase: Phase; message: string }>;
  lastTest?: TestRunResult;
  lastReview?: string;
};

type TestRunResult = {
  ok: boolean;
  commandCount: number;
  commands: Array<{
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
};

const workflowToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("status"),
    Type.Literal("pause"),
    Type.Literal("resume"),
    Type.Literal("abort"),
  ]),
});

type WorkflowToolParams = Static<typeof workflowToolSchema>;

function now() {
  return new Date().toISOString();
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

function statePath(id: string) {
  return join(STATE_DIR, `${id}.json`);
}

function writeState(state: WorkflowState) {
  ensureStateDir();
  writeFileSync(statePath(state.id), JSON.stringify(state, null, 2));
}

function workflowId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function truncate(value: string, max = MAX_LOG_CHARS) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]`;
}

function addLog(state: WorkflowState, phase: Phase, message: string, ctx?: ExtensionContext) {
  state.phase = phase;
  state.logs.push({ at: now(), phase, message });
  writeState(state);
  ctx?.ui.setStatus("autoflow", `${phase}: ${message.slice(0, 48)}`);
  ctx?.ui.setWidget("autoflow", [
    `autoflow ${state.id}`,
    `phase: ${phase}`,
    `task: ${state.task.slice(0, 100)}`,
    `tests: ${state.testCommands.join(" && ") || "none"}`,
    `fix loops: ${state.fixLoops}/${state.maxFixLoops}`,
  ]);
  ctx?.ui.notify(`autoflow: ${message}`, phase === "failed" ? "error" : "info");
}

function parseArgs(args: string, cwd: string) {
  const testCommands: string[] = [];
  let maxFixLoops = DEFAULT_MAX_FIX_LOOPS;
  let askUserBeforeFix = false;
  let rest = args.trim();

  rest = rest.replace(/--test\s+"([^"]+)"/g, (_m, cmd) => {
    testCommands.push(cmd.trim());
    return "";
  });
  rest = rest.replace(/--test\s+'([^']+)'/g, (_m, cmd) => {
    testCommands.push(cmd.trim());
    return "";
  });
  rest = rest.replace(/--max-fixes\s+(\d+)/g, (_m, n) => {
    maxFixLoops = Math.max(0, Math.min(10, Number(n)));
    return "";
  });
  rest = rest.replace(/--ask/g, () => {
    askUserBeforeFix = true;
    return "";
  });

  if (testCommands.length === 0) testCommands.push(...detectTestCommands(cwd));

  return {
    task: rest.trim(),
    testCommands,
    maxFixLoops,
    askUserBeforeFix,
  };
}

function detectTestCommands(cwd: string): string[] {
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts = pkg?.scripts ?? {};
    const commands: string[] = [];
    if (scripts.check) commands.push("npm run check");
    if (scripts.test) commands.push("npm test");
    if (scripts.lint) commands.push("npm run lint");
    if (scripts.build) commands.push("npm run build");
    return commands.slice(0, 3);
  } catch {
    return [];
  }
}

function execShell(command: string, cwd: string): Promise<TestRunResult["commands"][number]> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      resolve({
        command,
        exitCode: code,
        stdout: truncate(stdout, 20_000),
        stderr: truncate(stderr, 20_000),
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (error) => {
      resolve({
        command,
        exitCode: null,
        stdout: "",
        stderr: String(error),
        durationMs: Date.now() - started,
      });
    });
  });
}

function execText(command: string, cwd: string, maxChars = 80_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      resolve(truncate(`$ ${command}\nexit: ${code}\n\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`, maxChars));
    });
    child.on("error", (error) => resolve(`$ ${command}\nerror: ${String(error)}`));
  });
}

async function runTests(commands: string[], cwd: string): Promise<TestRunResult> {
  const results: TestRunResult["commands"] = [];
  for (const command of commands) {
    const result = await execShell(command, cwd);
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return {
    ok: results.length > 0 && results.every((r) => r.exitCode === 0),
    commandCount: commands.length,
    commands: results,
  };
}

function formatTestResult(result: TestRunResult) {
  return result.commands
    .map((r, i) => {
      return [
        `## Test ${i + 1}: ${r.command}`,
        `exit: ${r.exitCode} duration_ms: ${r.durationMs}`,
        r.stdout ? `### stdout\n\`\`\`\n${r.stdout}\n\`\`\`` : "",
        r.stderr ? `### stderr\n\`\`\`\n${r.stderr}\n\`\`\`` : "",
      ].filter(Boolean).join("\n\n");
    })
    .join("\n\n---\n\n");
}

async function gitSnapshot(cwd: string) {
  const status = await execText("git status --short", cwd, 20_000);
  const stat = await execText("git diff --stat", cwd, 20_000);
  const diff = await execText("git diff -- src app components lib server agents . ':!node_modules'", cwd, 120_000);
  return ["# Git status", status, "# Git diff stat", stat, "# Git diff", diff].join("\n\n");
}

function implementationPrompt(state: WorkflowState) {
  return `# Auto Workflow: implementation phase\n\nTask:\n${state.task}\n\nWorkflow rules:\n- Implement the smallest correct change.\n- Read relevant files before editing.\n- Do not mark done. The auto-workflow extension will run deterministic tests after this turn.\n- If the task is ambiguous or requires product judgment, call \`auto_workflow_control\` with action \`pause\`, then ask one focused question instead of guessing.\n- Avoid broad refactors.\n\nDeterministic tests that will run after implementation:\n${state.testCommands.length ? state.testCommands.map((c) => `- ${c}`).join("\n") : "- none detected; add/describe a validation command if needed"}`;
}

function cleanReviewPrompt(state: WorkflowState, snapshot: string) {
  return `# Fresh Auto Workflow Review\n\nYou are a clean-room reviewer in a separate fresh Pi process. You did not implement the change. Do not defend the implementation. Find real issues only.\n\n## Original task\n${state.task}\n\n## Deterministic test result\n${state.lastTest?.ok ? "PASS" : "FAIL OR MISSING"}\n\n${state.lastTest ? formatTestResult(state.lastTest) : "No test output available."}\n\n## Repository snapshot\n${snapshot}\n\n## Review rules\n- Read the changed files and any directly related files if needed.\n- Use read-only tools only. Do not edit files.\n- Look for correctness bugs, incomplete requirements, edge cases, stale assumptions, bad tests, or unsafe behavior.\n- Ignore style nits unless they affect maintainability or correctness.\n- If there are no substantive issues, output exactly:\n${REVIEW_OK_MARKER}\n- If there are issues, output:\n  1. severity\n  2. file/path\n  3. exact problem\n  4. concrete fix instruction for the implementation agent\n\nBe concise. This result will be fed back to the implementation session.`;
}

function fixPrompt(state: WorkflowState) {
  return `# Auto Workflow: fix phase\n\nFix the real problem, then stop. The extension will retest automatically and then run another fresh clean-room review.\n\n## Original task\n${state.task}\n\n## Latest deterministic test result\n${state.lastTest ? formatTestResult(state.lastTest) : "No test output available."}\n\n## Latest clean-room review\n${state.lastReview ? state.lastReview : "No clean-room review yet."}\n\nRules:\n- If tests failed, fix the failing cause first.\n- If review found issues, fix those specific issues.\n- Make the smallest fix.\n- Do not skip tests by weakening validation.\n- Do not claim success; the extension will verify.`;
}

function verificationPrompt(state: WorkflowState) {
  return `# Auto Workflow: final report\n\nThe deterministic tests passed and the fresh clean-room review returned ${REVIEW_OK_MARKER}.\n\n## Original task\n${state.task}\n\n## Final test output\n${state.lastTest ? formatTestResult(state.lastTest) : "No test output available."}\n\n## Clean-room review\n${state.lastReview ?? REVIEW_OK_MARKER}\n\nNow provide a concise final report:\n- what changed\n- test commands run\n- clean-room review result\n- any remaining risks or manual checks\n\nDo not edit files unless you discover a critical issue.`;
}

function runPiPrint(prompt: string, cwd: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-autoflow-review-"));
    const promptPath = join(dir, "prompt.md");
    writeFileSync(promptPath, prompt, { encoding: "utf8", mode: 0o600 });
    const child = spawn("pi", ["--no-session", "--tools", "read,bash,grep,find,ls", "-p", `@${promptPath}`], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr) }));
    child.on("error", (error) => resolve({ exitCode: null, stdout: "", stderr: String(error) }));
  });
}

async function runCleanReview(state: WorkflowState, ctx: ExtensionContext) {
  addLog(state, "reviewing", "spawning fresh clean-room Pi review", ctx);
  const snapshot = await gitSnapshot(state.cwd);
  const result = await runPiPrint(cleanReviewPrompt(state, snapshot), state.cwd);
  const review = truncate([
    result.stdout.trim(),
    result.stderr.trim() ? `\n[review stderr]\n${result.stderr.trim()}` : "",
    result.exitCode === 0 ? "" : `\n[review process exit: ${result.exitCode}]`,
  ].filter(Boolean).join("\n"));
  state.lastReview = review || `[empty review result; exit=${result.exitCode}]`;
  writeState(state);
  return state.lastReview;
}

function reviewPassed(review: string | undefined) {
  return Boolean(review && review.includes(REVIEW_OK_MARKER));
}

export default function (pi: ExtensionAPI) {
  let state: WorkflowState | null = null;
  let internallySending = false;

  const send = (prompt: string, deliverAs: "followUp" | "steer" = "followUp") => {
    internallySending = true;
    try {
      pi.sendUserMessage(prompt, { deliverAs });
    } finally {
      setTimeout(() => {
        internallySending = false;
      }, 0);
    }
  };

  pi.registerCommand("autoflow", {
    description: "Run code workflow: implement → tests → fresh clean-room review → fix/retest/review → verify",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args, ctx.cwd);
      if (!parsed.task) {
        ctx.ui.notify('Usage: /autoflow [--test "npm run check"] [--max-fixes 2] [--ask] <task>', "warning");
        return;
      }
      if (state?.active) {
        ctx.ui.notify(`autoflow already active: ${state.id}. Use /autoflow-abort first.`, "warning");
        return;
      }

      state = {
        active: true,
        id: workflowId(),
        task: parsed.task,
        cwd: ctx.cwd,
        phase: "idle",
        testCommands: parsed.testCommands,
        fixLoops: 0,
        maxFixLoops: parsed.maxFixLoops,
        askUserBeforeFix: parsed.askUserBeforeFix,
        logs: [],
      };
      addLog(state, "implementing", "started implementation", ctx);
      send(implementationPrompt(state));
    },
  });

  pi.registerCommand("autoflow-status", {
    description: "Show current auto workflow status",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("no autoflow state", "info");
        return;
      }
      ctx.ui.notify(`autoflow ${state.id}: ${state.active ? "active" : "paused"} ${state.phase} (${state.fixLoops}/${state.maxFixLoops})`, "info");
    },
  });

  pi.registerCommand("autoflow-resume", {
    description: "Resume a paused auto workflow",
    handler: async (_args, ctx) => {
      if (!state) {
        ctx.ui.notify("no paused autoflow", "info");
        return;
      }
      state.active = true;
      addLog(state, state.phase, "resumed by user", ctx);
      send(`Resume the auto workflow. Continue the current phase (${state.phase}) for this original task:\n\n${state.task}`);
    },
  });

  pi.registerCommand("autoflow-abort", {
    description: "Abort current auto workflow",
    handler: async (_args, ctx) => {
      if (!state) return;
      addLog(state, "failed", "aborted by user", ctx);
      state.active = false;
      writeState(state);
      state = null;
      ctx.ui.setWidget("autoflow", undefined as any);
    },
  });

  pi.registerTool({
    name: "auto_workflow_control",
    label: "Auto Workflow Control",
    description: "Inspect or control the active auto-workflow loop.",
    promptSnippet: "Inspect or control the active implementation/test/review workflow",
    promptGuidelines: [
      "Use auto_workflow_control only when managing the auto workflow status, pause/resume, or abort.",
    ],
    parameters: workflowToolSchema,
    async execute(_id, params: WorkflowToolParams) {
      if (!state) return { content: [{ type: "text", text: "No active auto workflow." }] };
      if (params.action === "abort") {
        state.active = false;
        state.phase = "failed";
        writeState(state);
        return { content: [{ type: "text", text: `Aborted autoflow ${state.id}` }], details: state };
      }
      if (params.action === "pause") {
        state.active = false;
        writeState(state);
        return { content: [{ type: "text", text: `Paused autoflow ${state.id}. User can resume with /autoflow-resume.` }], details: state };
      }
      if (params.action === "resume") {
        state.active = true;
        writeState(state);
        return { content: [{ type: "text", text: `Resumed autoflow ${state.id}.` }], details: state };
      }
      return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }], details: state };
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state?.active) return;
    if (internallySending) return;

    if (state.phase === "implementing") {
      addLog(state, "testing_after_implement", "running deterministic tests", ctx);
      if (state.testCommands.length > 0) {
        state.lastTest = await runTests(state.testCommands, state.cwd);
        writeState(state);
      }
      if (state.lastTest && !state.lastTest.ok) {
        addLog(state, "fixing", "tests failed; requesting fix", ctx);
        if (state.askUserBeforeFix && ctx.hasUI) {
          const ok = await ctx.ui.confirm("Auto workflow", "Tests failed. Allow the agent to attempt a fix?");
          if (!ok) {
            addLog(state, "failed", "stopped before fix by user", ctx);
            state.active = false;
            writeState(state);
            return;
          }
        }
        send(fixPrompt(state));
        return;
      }

      const review = await runCleanReview(state, ctx);
      if (reviewPassed(review)) {
        addLog(state, "verifying", "clean-room review passed", ctx);
        send(verificationPrompt(state));
      } else {
        addLog(state, "fixing", "clean-room review found issues", ctx);
        send(fixPrompt(state));
      }
      return;
    }

    if (state.phase === "fixing") {
      addLog(state, "testing_after_fix", "running fix tests", ctx);
      if (state.testCommands.length > 0) {
        state.lastTest = await runTests(state.testCommands, state.cwd);
        writeState(state);
      }
      if (state.lastTest && !state.lastTest.ok) {
        if (state.fixLoops < state.maxFixLoops) {
          state.fixLoops += 1;
          addLog(state, "fixing", "tests still failing; another fix loop", ctx);
          send(fixPrompt(state));
        } else {
          addLog(state, "failed", "max fix loops reached with failing tests", ctx);
          state.active = false;
          writeState(state);
        }
        return;
      }

      const review = await runCleanReview(state, ctx);
      if (reviewPassed(review)) {
        addLog(state, "verifying", "clean-room review passed", ctx);
        send(verificationPrompt(state));
      } else if (state.fixLoops < state.maxFixLoops) {
        state.fixLoops += 1;
        addLog(state, "fixing", "clean-room review still found issues", ctx);
        send(fixPrompt(state));
      } else {
        addLog(state, "failed", "max fix loops reached with review issues", ctx);
        state.active = false;
        writeState(state);
      }
      return;
    }

    if (state.phase === "verifying") {
      addLog(state, "done", "workflow complete", ctx);
      state.active = false;
      writeState(state);
      state = null;
      ctx.ui.setStatus("autoflow", "done");
      ctx.ui.setWidget("autoflow", undefined as any);
    }
  });
}
