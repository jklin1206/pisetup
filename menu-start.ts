import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

type Rgb = [number, number, number];

interface MenuStartConfig {
  enabled: boolean;
  logo: string[];
  eyebrow: string;
  subtext: string;
  loadingText: string;
  showHairline: boolean;
  hairlineWidth: number;
  animationMs: number;
  frameMs: number;
  status: {
    enabled: boolean;
    refreshMs: number;
    showCwd: boolean;
    showGit: boolean;
    showModel: boolean;
    showContext: boolean;
    showMessages: boolean;
  };
  colors: {
    ink: string;
    muted: string;
    dim: string;
    accent: string;
    accentHot: string;
    accentCool: string;
    loading: string;
  };
}

const DEFAULT_CONFIG: MenuStartConfig = {
  enabled: true,
  logo: [
    "   ███████████████████████████╗  ",
    "   ╚══██████╔════════██████╔══╝  ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "   ████████████╗  ████████████╗  ",
    "   ╚═══════════╝  ╚═══════════╝  ",
  ],
  eyebrow: "",
  subtext: "",
  loadingText: "loading",
  showHairline: true,
  hairlineWidth: 44,
  animationMs: 0,
  frameMs: 1000,
  status: {
    enabled: true,
    refreshMs: 1200,
    showCwd: true,
    showGit: true,
    showModel: true,
    showContext: true,
    showMessages: true,
  },
  colors: {
    ink: "#e8f7ff",
    muted: "#8fb2c7",
    dim: "#4e6b7a",
    accent: "#5ba4e6",
    accentHot: "#7ec8f0",
    accentCool: "#2d6db5",
    loading: "#76e3ea",
  },
};

function hexToRgb(hex: string, fallback: Rgb): Rgb {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return fallback;
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function fg([r, g, b]: Rgb, text: string) {
  return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function bold(text: string) {
  return `${BOLD}${text}${RESET}`;
}

function dim(text: string) {
  return `${DIM}${text}${RESET}`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(text: string) {
  return [...stripAnsi(text)].length;
}

function truncateVisible(text: string, width: number) {
  if (visibleLength(text) <= width) return text;
  const plain = stripAnsi(text);
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function center(text: string, width: number) {
  const safe = truncateVisible(text, width);
  const len = visibleLength(safe);
  if (len >= width) return safe;
  return `${" ".repeat(Math.floor((width - len) / 2))}${safe}`;
}

function deepMerge(base: MenuStartConfig, overrides: Partial<MenuStartConfig>): MenuStartConfig {
  return {
    ...base,
    ...overrides,
    logo: Array.isArray(overrides.logo) ? overrides.logo : base.logo,
    status: {
      ...base.status,
      ...(overrides.status ?? {}),
    },
    colors: {
      ...base.colors,
      ...(overrides.colors ?? {}),
    },
  };
}

function readJson(path: string): Partial<MenuStartConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<MenuStartConfig>;
  } catch (error) {
    console.error(`Warning: could not parse ${path}: ${error}`);
    return {};
  }
}

function loadConfig(cwd: string): MenuStartConfig {
  const globalPath = join(getAgentDir(), "extensions", "menu-start.json");
  const projectPath = join(cwd, ".pi", "menu-start.json");
  return deepMerge(deepMerge(DEFAULT_CONFIG, readJson(globalPath)), readJson(projectPath));
}

function gitBranch(cwd: string) {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 250,
    }).trim();
  } catch {
    return "";
  }
}

function formatModel(ctx: ExtensionContext) {
  const model = ctx.model;
  if (!model) return "model pending";
  return `${model.provider}/${model.id}`;
}

function formatContext(ctx: ExtensionContext) {
  const usage = ctx.getContextUsage();
  if (!usage) return "context pending";
  const percent = usage.contextWindow ? Math.round((usage.tokens / usage.contextWindow) * 100) : undefined;
  return percent === undefined ? `${usage.tokens.toLocaleString()} tok` : `${percent}% context`;
}

function formatMessages(ctx: ExtensionContext) {
  return `${ctx.sessionManager.getBranch().length} msgs`;
}

function statusItems(ctx: ExtensionContext, config: MenuStartConfig) {
  const items: string[] = [];
  if (config.status.showCwd) items.push(`cwd ${basename(ctx.cwd) || ctx.cwd}`);
  if (config.status.showGit) {
    const branch = gitBranch(ctx.cwd);
    items.push(branch ? `git ${branch}` : "git none");
  }
  if (config.status.showModel) items.push(formatModel(ctx));
  if (config.status.showContext) items.push(formatContext(ctx));
  if (config.status.showMessages) items.push(formatMessages(ctx));
  return items;
}

function renderPill(label: string, index: number, colors: { muted: Rgb; accent: Rgb; accentCool: Rgb }) {
  const dotColor = index % 2 === 0 ? colors.accent : colors.accentCool;
  return `${fg(dotColor, "●")} ${fg(colors.muted, label)}`;
}

function normalizeLogo(logo: string[]) {
  const width = Math.max(0, ...logo.map((line) => visibleLength(line)));
  return logo.map((line) => line.padEnd(width, " "));
}

function renderLogoLine(line: string, row: number, rowCount: number, colors: { accentCool: Rgb; accent: Rgb; accentHot: Rgb }) {
  const chars = [...line];
  const lastCol = Math.max(1, chars.length - 1);
  const lastRow = Math.max(1, rowCount - 1);

  return chars
    .map((char, col) => {
      if (char === " ") return char;

      const horizontal = col / lastCol;
      const vertical = row / lastRow;
      const diagonal = Math.min(1, horizontal * 0.58 + vertical * 0.42);
      const sweep = (Math.sin((horizontal * 0.9 + vertical * 0.55) * Math.PI) + 1) / 2;
      const base = diagonal < 0.52
        ? mix(colors.accentCool, colors.accent, diagonal / 0.52)
        : mix(colors.accent, colors.accentHot, (diagonal - 0.52) / 0.48);
      const glow = mix(base, colors.accentHot, sweep * 0.18);
      return fg(glow, char);
    })
    .join("");
}

function renderHeader(width: number, _startedAt: number, config: MenuStartConfig, ctx: ExtensionContext) {
  const ink = hexToRgb(config.colors.ink, [232, 247, 255]);
  const muted = hexToRgb(config.colors.muted, [143, 178, 199]);
  const dimColor = hexToRgb(config.colors.dim, [78, 107, 122]);
  const accent = hexToRgb(config.colors.accent, [91, 164, 230]);
  const accentHot = hexToRgb(config.colors.accentHot, [126, 200, 240]);
  const accentCool = hexToRgb(config.colors.accentCool, [45, 109, 181]);
  const loadingColor = hexToRgb(config.colors.loading, accent);
  const loading = config.loadingText;
  const hairlineLength = Math.min(config.hairlineWidth, Math.max(12, width - 12));
  const hairline = [..."─".repeat(hairlineLength)]
    .map((char, index) => fg(mix(accentCool, accentHot, hairlineLength <= 1 ? 0 : index / (hairlineLength - 1)), char))
    .join("");
  const items = config.status.enabled ? statusItems(ctx, config) : [];
  const statusLine = items.map((item, index) => renderPill(item, index, { muted, accent, accentCool })).join(fg(dimColor, "  •  "));

  const logo = normalizeLogo(config.logo);

  return [
    "",
    ...logo.map((line, index) => center(bold(renderLogoLine(line, index, logo.length, { accentCool, accent, accentHot })), width)),
    ...(config.showHairline ? [center(hairline, width)] : []),
    ...(config.subtext ? [center(fg(ink, config.subtext), width)] : []),
    ...(loading ? [center(fg(loadingColor, loading), width)] : []),
    ...(statusLine ? [center(statusLine, width)] : []),
    "",
  ];
}

export default function (pi: ExtensionAPI) {
  let enabled = process.env.PI_MENU_START_DISABLED !== "1" && process.env.PI_QUIET_HEADER_DISABLED !== "1";
  let animationTimer: ReturnType<typeof setInterval> | undefined;

  function stopAnimation() {
    if (!animationTimer) return;
    clearInterval(animationTimer);
    animationTimer = undefined;
  }

  function install(ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);
    enabled = config.enabled && process.env.PI_MENU_START_DISABLED !== "1" && process.env.PI_QUIET_HEADER_DISABLED !== "1";
    if (!ctx.hasUI || !enabled) return;

    const startedAt = Date.now();
    stopAnimation();
    ctx.ui.setStatus("menu-start", dim("Π ready"));
    ctx.ui.setHeader((tui) => {
      let slowMode = false;
      animationTimer = setInterval(() => {
        tui.requestRender();
        if (Date.now() - startedAt <= config.animationMs + 500) return;

        stopAnimation();
        if (!config.status.enabled || slowMode) return;
        slowMode = true;
        animationTimer = setInterval(() => tui.requestRender(), Math.max(500, config.status.refreshMs));
      }, Math.max(80, config.frameMs));

      return {
        render(width: number) {
          return renderHeader(width, startedAt, config, ctx);
        },
        invalidate() {},
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    install(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    install(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopAnimation();
    if (ctx.hasUI) {
      ctx.ui.setStatus("menu-start", undefined);
      ctx.ui.setWidget("menu-start", undefined);
      ctx.ui.setHeader(undefined);
    }
  });

  const enableMenuStart = async (_args: string, ctx: ExtensionContext) => {
    enabled = true;
    install(ctx);
    ctx.ui.notify("Π Menu Start online", "info");
  };

  const disableMenuStart = async (_args: string, ctx: ExtensionContext) => {
    enabled = false;
    stopAnimation();
    ctx.ui.setStatus("menu-start", undefined);
    ctx.ui.setWidget("menu-start", undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.notify("Default Pi header restored", "info");
  };

  pi.registerCommand("menu-start", {
    description: "Enable or reload the polished Π Menu Start header",
    handler: enableMenuStart,
  });

  pi.registerCommand("menu-start-off", {
    description: "Restore Pi's default header for this session",
    handler: disableMenuStart,
  });

  pi.registerCommand("menu-start-config", {
    description: "Show where to customize the Π Menu Start header",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Edit ${join(getAgentDir(), "extensions", "menu-start.json")} then run /reload`, "info");
    },
  });

  pi.registerCommand("chill", {
    description: "Alias for /menu-start",
    handler: enableMenuStart,
  });

  pi.registerCommand("chill-off", {
    description: "Alias for /menu-start-off",
    handler: disableMenuStart,
  });
}
