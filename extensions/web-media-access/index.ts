import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { execFile } from "node:child_process";

const FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1";
const FIRECRAWL_KEY_FILE = join(homedir(), ".pi", "agent", "firecrawl-api-key");
const DEFAULT_MAX_CHARS = 80_000;
const HARD_MAX_CHARS = 200_000;
const DEFAULT_VIDEO_FRAMES = 8;
const MAX_VIDEO_FRAMES = 24;
const WATCH_ENV_FILE = join(homedir(), ".config", "watch", ".env");
const VIDEO_EXTENSIONS: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
};

const fetchSchema = Type.Object({
  url: Type.String({ description: "URL to scrape/read with Firecrawl." }),
  maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return. Default 80000, max 200000." })),
  onlyMainContent: Type.Optional(Type.Boolean({ description: "Extract only main page content. Default true." })),
});
type FetchParams = Static<typeof fetchSchema>;

const searchSchema = Type.Object({
  query: Type.String({ description: "Search query." }),
  limit: Type.Optional(Type.Number({ description: "Number of results. Default 5, max 10." })),
  scrapeResults: Type.Optional(Type.Boolean({ description: "Also scrape each result into markdown when supported. Default true." })),
  maxCharsPerResult: Type.Optional(Type.Number({ description: "Maximum scraped text per result. Default 12000." })),
});
type SearchParams = Static<typeof searchSchema>;

const crawlSchema = Type.Object({
  url: Type.String({ description: "URL to crawl with Firecrawl." }),
  limit: Type.Optional(Type.Number({ description: "Maximum pages. Default 10, max 50." })),
  maxDepth: Type.Optional(Type.Number({ description: "Maximum crawl depth when supported. Default 2, max 5." })),
  maxCharsPerPage: Type.Optional(Type.Number({ description: "Maximum characters per page. Default 12000." })),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Polling timeout for async crawl. Default 120, max 300." })),
});
type CrawlParams = Static<typeof crawlSchema>;

const youtubeSearchSchema = Type.Object({
  query: Type.String({ description: "YouTube search query." }),
  maxResults: Type.Optional(Type.Number({ description: "Maximum results. Default 5, max 20." })),
  minDuration: Type.Optional(Type.Number({ description: "Minimum duration in seconds." })),
  maxDuration: Type.Optional(Type.Number({ description: "Maximum duration in seconds." })),
});
type YoutubeSearchParams = Static<typeof youtubeSearchSchema>;

const videoExtractSchema = Type.Object({
  url: Type.String({ description: "YouTube URL or local video file path." }),
  prompt: Type.Optional(Type.String({ description: "Question/instruction for the video. Used in the returned extraction brief and Gemini path when available." })),
  timestamp: Type.Optional(Type.String({ description: "Timestamp or range for frame extraction: 85, 1:25, 1:20-1:50." })),
  frames: Type.Optional(Type.Number({ description: "Number of frames to extract. Default 8, max 24." })),
  includeTranscript: Type.Optional(Type.Boolean({ description: "For YouTube, extract captions/transcript with yt-dlp when available. Default true." })),
  mode: Type.Optional(Type.String({ description: "frames | transcript | auto. Default auto." })),
  keepFiles: Type.Optional(Type.Boolean({ description: "Keep temp files for follow-up inspection. Default false." })),
});
type VideoExtractParams = Static<typeof videoExtractSchema>;

const githubFetchSchema = Type.Object({
  url: Type.String({ description: "GitHub repo/blob/tree URL." }),
  forceClone: Type.Optional(Type.Boolean({ description: "Clone repo even when a lightweight fetch might work. Default false." })),
});
type GithubFetchParams = Static<typeof githubFetchSchema>;

function getFirecrawlApiKey() {
  const fromEnv = process.env.FIRECRAWL_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(FIRECRAWL_KEY_FILE)) return readFileSync(FIRECRAWL_KEY_FILE, "utf8").trim();
  throw new Error("Missing Firecrawl API key. Set FIRECRAWL_API_KEY or create ~/.pi/agent/firecrawl-api-key.");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Truncated: ${text.length - maxChars} more characters omitted]`;
}

async function firecrawl(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(`${FIRECRAWL_API_URL}${path}`, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${getFirecrawlApiKey()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || text || `Firecrawl request failed with ${response.status}`);
  }
  return data;
}

async function firecrawlGet(path: string, signal?: AbortSignal) {
  const response = await fetch(`${FIRECRAWL_API_URL}${path}`, {
    method: "GET",
    signal,
    headers: { authorization: `Bearer ${getFirecrawlApiKey()}` },
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || data?.message || text || `Firecrawl request failed with ${response.status}`);
  }
  return data;
}

function pageText(page: any) { return page?.markdown || page?.content || page?.text || page?.html || ""; }
function pageMetadata(page: any) { return page?.metadata || page?.data?.metadata || {}; }

function execFileAsync(cmd: string, args: string[], opts: { timeout?: number; encoding?: BufferEncoding | "buffer"; maxBuffer?: number; signal?: AbortSignal } = {}) {
  return new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolvePromise, reject) => {
    const child = execFile(cmd, args, {
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
      encoding: opts.encoding === "buffer" ? "buffer" : opts.encoding ?? "utf8",
    }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
    if (opts.signal) {
      const abort = () => {
        child.kill("SIGTERM");
        reject(new Error("Aborted"));
      };
      opts.signal.addEventListener("abort", abort, { once: true });
      child.on("exit", () => opts.signal?.removeEventListener("abort", abort));
    }
  });
}

function formatDuration(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "?:??";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function parseTimestamp(value: string): number | null {
  const trimmed = value.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.floor(asNumber);
  const parts = trimmed.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
  return null;
}

function parseTimestampRange(value?: string): { start: number; end?: number } | null {
  if (!value) return null;
  const split = value.split("-");
  if (split.length === 2) {
    const start = parseTimestamp(split[0]);
    const end = parseTimestamp(split[1]);
    if (start === null || end === null || end <= start) return null;
    return { start, end };
  }
  const start = parseTimestamp(value);
  return start === null ? null : { start };
}

function sampleTimestamps(duration: number | null, range: { start: number; end?: number } | null, count: number) {
  if (range?.end !== undefined) {
    if (count <= 1) return [range.start];
    return Array.from({ length: count }, (_, i) => Math.round(range.start + ((range.end! - range.start) * i) / (count - 1)));
  }
  if (range) {
    if (count <= 1) return [range.start];
    return Array.from({ length: count }, (_, i) => range.start + i * 5);
  }
  const dur = duration && duration > 0 ? duration : count * 10;
  if (count <= 1) return [Math.min(1, dur)];
  return Array.from({ length: count }, (_, i) => Math.max(0, Math.round((dur * i) / (count - 1))));
}

function youtubeId(input: string) {
  const match = input.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] ?? null;
}

function isLocalVideoPath(input: string) {
  const path = input.startsWith("file://") ? new URL(input).pathname : input;
  const looksPath = path.startsWith("/") || path.startsWith("./") || path.startsWith("../");
  if (!looksPath) return null;
  const absolute = resolve(path);
  const ext = extname(absolute).toLowerCase();
  if (!VIDEO_EXTENSIONS[ext]) return null;
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  return absolute;
}

async function getLocalDuration(filePath: string, signal?: AbortSignal) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", filePath], { timeout: 10_000, encoding: "utf8", signal });
  const duration = Number.parseFloat(String(stdout).trim());
  return Number.isFinite(duration) ? duration : null;
}

async function getYouTubeInfo(url: string, signal?: AbortSignal) {
  const { stdout } = await execFileAsync("yt-dlp", ["--dump-json", "--no-download", url], { timeout: 30_000, encoding: "utf8", signal, maxBuffer: 10 * 1024 * 1024 });
  const data = JSON.parse(String(stdout));
  return {
    title: data.title as string | undefined,
    duration: typeof data.duration === "number" ? data.duration : null,
    channel: data.channel || data.uploader || undefined,
    webpageUrl: data.webpage_url || url,
  };
}

async function getYouTubeStreamUrl(url: string, signal?: AbortSignal) {
  const { stdout } = await execFileAsync("yt-dlp", ["-f", "bestvideo[height<=720]/best[height<=720]/best", "-g", url], { timeout: 30_000, encoding: "utf8", signal });
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
  return lines[0];
}

async function extractFrame(input: string, seconds: number, outFile: string, signal?: AbortSignal) {
  await execFileAsync("ffmpeg", ["-y", "-ss", String(seconds), "-i", input, "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", outFile], { timeout: 30_000, encoding: "utf8", signal, maxBuffer: 5 * 1024 * 1024 });
  return readFile(outFile);
}

function cleanVtt(vtt: string) {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "WEBVTT" || trimmed.startsWith("Kind:") || trimmed.startsWith("Language:")) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (trimmed.includes("-->")) {
      out.push(`\n[${trimmed.split(" --> ")[0]?.replace(".000", "") ?? trimmed}]`);
      continue;
    }
    const cleaned = trimmed.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.join(" ").replace(/\n /g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractYouTubeTranscript(url: string, workDir: string, signal?: AbortSignal) {
  try {
    const outTemplate = join(workDir, "subs.%(ext)s");
    await execFileAsync("yt-dlp", ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "en.*,en", "--sub-format", "vtt", "-o", outTemplate, url], { timeout: 45_000, encoding: "utf8", signal, maxBuffer: 5 * 1024 * 1024 });
    const file = readdirSync(workDir).find((f) => f.endsWith(".vtt"));
    if (!file) return "";
    return cleanVtt(readFileSync(join(workDir, file), "utf8"));
  } catch {
    return "";
  }
}

function loadDotEnvKey(name: string) {
  if (!existsSync(WATCH_ENV_FILE)) return undefined;
  const lines = readFileSync(WATCH_ENV_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    if (trimmed.slice(0, idx).trim() === name) return trimmed.slice(idx + 1).trim().replace(/^['\"]|['\"]$/g, "");
  }
  return undefined;
}

function getWhisperConfig() {
  const groq = process.env.GROQ_API_KEY || loadDotEnvKey("GROQ_API_KEY");
  if (groq) return { provider: "groq", apiKey: groq, url: "https://api.groq.com/openai/v1/audio/transcriptions", model: "whisper-large-v3" };
  const openai = process.env.OPENAI_API_KEY || loadDotEnvKey("OPENAI_API_KEY");
  if (openai) return { provider: "openai", apiKey: openai, url: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1" };
  return undefined;
}

async function extractAudioForWhisper(source: string, outFile: string, signal?: AbortSignal) {
  await execFileAsync("ffmpeg", ["-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", outFile], { timeout: 120_000, encoding: "utf8", signal, maxBuffer: 10 * 1024 * 1024 });
}

async function downloadYouTubeAudio(url: string, workDir: string, signal?: AbortSignal) {
  const outTemplate = join(workDir, "audio.%(ext)s");
  await execFileAsync("yt-dlp", ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "64K", "-o", outTemplate, url], { timeout: 180_000, encoding: "utf8", signal, maxBuffer: 10 * 1024 * 1024 });
  return readdirSync(workDir).find((f) => f.startsWith("audio.") && !f.endsWith(".part")) ? join(workDir, readdirSync(workDir).find((f) => f.startsWith("audio.") && !f.endsWith(".part"))!) : undefined;
}

async function transcribeWithWhisper(audioFile: string, signal?: AbortSignal) {
  const config = getWhisperConfig();
  if (!config) return { text: "", provider: "none" };
  const form = new FormData();
  const audio = await readFile(audioFile);
  form.append("file", new Blob([audio]), basename(audioFile));
  form.append("model", config.model);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  const response = await fetch(config.url, { method: "POST", signal, headers: { authorization: `Bearer ${config.apiKey}` }, body: form });
  const body = await response.text();
  if (!response.ok) throw new Error(`Whisper ${config.provider} failed: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const text = segments.length > 0
    ? segments.map((s: any) => `[${formatDuration(s.start ?? 0)}] ${String(s.text ?? "").trim()}`).join("\n")
    : String(data.text ?? "").trim();
  return { text, provider: config.provider };
}

async function youtubeSearch(params: YoutubeSearchParams, signal?: AbortSignal) {
  const maxResults = clampNumber(params.maxResults, 5, 1, 20);
  const { stdout } = await execFileAsync("yt-dlp", ["--dump-json", "--no-download", `ytsearch${maxResults}:${params.query}`], { timeout: 30_000, encoding: "utf8", signal, maxBuffer: 20 * 1024 * 1024 });
  const results = String(stdout).split(/\r?\n/).filter((line) => line.trim().startsWith("{")).flatMap((line) => {
    try {
      const data = JSON.parse(line);
      const duration = typeof data.duration === "number" ? data.duration : null;
      if (params.minDuration !== undefined && (duration === null || duration < params.minDuration)) return [];
      if (params.maxDuration !== undefined && (duration === null || duration > params.maxDuration)) return [];
      return [{
        title: data.title || "(untitled)",
        url: data.webpage_url || (data.id ? `https://www.youtube.com/watch?v=${data.id}` : ""),
        channel: data.channel || data.uploader || "",
        duration,
        views: typeof data.view_count === "number" ? data.view_count : null,
        uploadDate: data.upload_date || "",
        thumbnail: data.thumbnail || "",
      }];
    } catch { return []; }
  });
  return results;
}

function formatCrawlPages(startUrl: string, pages: any[], maxCharsPerPage: number) {
  return [
    `Crawled: ${startUrl}`,
    `Pages: ${pages.length}`,
    "",
    ...pages.map((page, index) => {
      const metadata = pageMetadata(page);
      const url = metadata.sourceURL || metadata.url || page.url || "";
      const title = metadata.title || url || `Page ${index + 1}`;
      const description = metadata.description || "";
      const markdown = truncate(pageText(page), maxCharsPerPage);
      return [`## ${index + 1}. ${title}`, url ? `URL: ${url}` : undefined, description ? `Description: ${description}` : undefined, "", markdown || "[No markdown content returned]"].filter(Boolean).join("\n");
    }),
  ].join("\n\n---\n\n");
}

function parseGithubUrl(input: string) {
  const url = new URL(input);
  if (url.hostname !== "github.com") throw new Error("github_fetch only supports github.com URLs");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Expected GitHub URL with owner/repo");
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, ""), parts };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Scrape/read a public URL using Firecrawl and return clean markdown plus metadata.",
    promptSnippet: "Scrape a URL with Firecrawl and return clean markdown",
    promptGuidelines: ["Use web_fetch when the user provides a URL and wants reliable page reading/scraping.", "web_fetch uses Firecrawl; prefer it over local curl for web pages, docs, and JS-heavy sites."],
    parameters: fetchSchema,
    async execute(_id, params: FetchParams, signal) {
      const maxChars = clampNumber(params.maxChars, DEFAULT_MAX_CHARS, 1_000, HARD_MAX_CHARS);
      const result = await firecrawl("/scrape", { url: params.url, formats: ["markdown"], onlyMainContent: params.onlyMainContent !== false }, signal);
      const data = result.data ?? result;
      const metadata = pageMetadata(data);
      const text = truncate(pageText(data), maxChars);
      const output = [`URL: ${params.url}`, metadata?.sourceURL && metadata.sourceURL !== params.url ? `Source URL: ${metadata.sourceURL}` : undefined, metadata?.title ? `Title: ${metadata.title}` : undefined, metadata?.description ? `Description: ${metadata.description}` : undefined, "", text || "[No markdown content returned]"].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: output }], details: { url: params.url, metadata, textLength: text.length } };
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web with Firecrawl and optionally scrape result pages into markdown.",
    promptSnippet: "Search the web with Firecrawl and optionally scrape results",
    promptGuidelines: ["Use web_search for current web research, discovery, comparisons, or sources.", "Cite result URLs from web_search when answering research questions."],
    parameters: searchSchema,
    async execute(_id, params: SearchParams, signal) {
      const limit = clampNumber(params.limit, 5, 1, 10);
      const maxCharsPerResult = clampNumber(params.maxCharsPerResult, 12_000, 1_000, 40_000);
      const result = await firecrawl("/search", { query: params.query, limit, scrapeOptions: params.scrapeResults !== false ? { formats: ["markdown"], onlyMainContent: true } : undefined }, signal);
      const results: any[] = Array.isArray(result.data) ? result.data : Array.isArray(result.results) ? result.results : [];
      const output = [`Query: ${params.query}`, `Results: ${results.length}`, "", ...results.map((item, index) => {
        const metadata = pageMetadata(item);
        const title = item.title || metadata.title || item.url || `Result ${index + 1}`;
        const url = item.url || metadata.sourceURL || metadata.url || "";
        const description = item.description || metadata.description || "";
        const markdown = pageText(item);
        return [`## ${index + 1}. ${title}`, url ? `URL: ${url}` : undefined, description ? `Description: ${description}` : undefined, markdown ? "" : undefined, markdown ? truncate(markdown, maxCharsPerResult) : undefined].filter(Boolean).join("\n");
      })].join("\n");
      return { content: [{ type: "text", text: truncate(output, HARD_MAX_CHARS) }], details: { query: params.query, count: results.length, results } };
    },
  });

  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description: "Crawl a site or docs section with Firecrawl and return markdown for discovered pages.",
    promptSnippet: "Crawl a website/docs section with Firecrawl",
    promptGuidelines: ["Use web_crawl to inspect multiple pages in a site, docs, changelog, or knowledge base.", "Keep web_crawl targeted; set reasonable page limits and cite crawled URLs."],
    parameters: crawlSchema,
    async execute(_id, params: CrawlParams, signal, onUpdate) {
      const limit = clampNumber(params.limit, 10, 1, 50);
      const maxDepth = clampNumber(params.maxDepth, 2, 0, 5);
      const maxCharsPerPage = clampNumber(params.maxCharsPerPage, 12_000, 1_000, 40_000);
      const timeoutSeconds = clampNumber(params.timeoutSeconds, 120, 10, 300);
      const start = await firecrawl("/crawl", { url: params.url, limit, maxDepth, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }, signal);
      const id = start.id || start.jobId || start.data?.id;
      if (!id) {
        const pages = Array.isArray(start.data) ? start.data : [];
        return { content: [{ type: "text", text: formatCrawlPages(params.url, pages, maxCharsPerPage) }], details: { url: params.url, pages } };
      }
      const deadline = Date.now() + timeoutSeconds * 1000;
      let status: any = start;
      while (Date.now() < deadline) {
        status = await firecrawlGet(`/crawl/${id}`, signal);
        const state = status.status || status.data?.status;
        const completed = status.completed || status.data?.completed || 0;
        const total = status.total || status.data?.total || limit;
        onUpdate?.({ content: [{ type: "text", text: `Firecrawl crawl ${state ?? "running"}: ${completed}/${total}` }] });
        if (["completed", "failed", "cancelled"].includes(String(state))) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      const state = status.status || status.data?.status;
      if (state && state !== "completed") throw new Error(`Firecrawl crawl ended with status: ${state}`);
      const pages: any[] = Array.isArray(status.data) ? status.data : Array.isArray(status.data?.data) ? status.data.data : [];
      return { content: [{ type: "text", text: truncate(formatCrawlPages(params.url, pages, maxCharsPerPage), HARD_MAX_CHARS) }], details: { url: params.url, crawlId: id, count: pages.length, pages } };
    },
  });

  pi.registerTool({
    name: "youtube_search",
    label: "YouTube Search",
    description: "Search YouTube videos using yt-dlp and return title, URL, duration, views, channel, upload date, and thumbnail.",
    promptSnippet: "Search YouTube videos using yt-dlp",
    promptGuidelines: ["Use youtube_search when the user wants to find videos, talks, demos, Shorts, tutorials, or references on YouTube."],
    parameters: youtubeSearchSchema,
    async execute(_id, params: YoutubeSearchParams, signal) {
      const results = await youtubeSearch(params, signal);
      const text = results.length === 0 ? `No YouTube results found for ${params.query}` : results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Duration: ${formatDuration(r.duration)} | Views: ${r.views?.toLocaleString() ?? "?"}\n   Channel: ${r.channel || "?"} | Uploaded: ${r.uploadDate || "?"}`).join("\n\n");
      return { content: [{ type: "text", text }], details: { query: params.query, results } };
    },
  });

  pi.registerTool({
    name: "video_extract",
    label: "Video Extract",
    description: "Extract frames and transcript from YouTube or local video files. Uses yt-dlp for YouTube metadata/captions and ffmpeg for frames. Supports timestamp/range extraction.",
    promptSnippet: "Extract frames/transcript from YouTube or local video files",
    promptGuidelines: ["Use video_extract for video URLs or local videos before answering visual/timestamp questions.", "Prefer timestamp/range extraction for long videos.", "Use /watch no longer; video_extract is the replacement."],
    parameters: videoExtractSchema,
    async execute(_id, params: VideoExtractParams, signal, onUpdate) {
      const mode = params.mode ?? "auto";
      const includeTranscript = params.includeTranscript !== false;
      const requestedFrames = clampNumber(params.frames, DEFAULT_VIDEO_FRAMES, 1, MAX_VIDEO_FRAMES);
      const range = parseTimestampRange(params.timestamp);
      if (params.timestamp && !range) throw new Error(`Invalid timestamp/range: ${params.timestamp}`);

      const workDir = mkdtempSync(join(tmpdir(), "pi-video-"));
      let cleanup = !params.keepFiles;
      try {
        const yt = youtubeId(params.url);
        const local = isLocalVideoPath(params.url);
        if (!yt && !local) throw new Error("video_extract supports YouTube URLs and local video files only.");

        let title = local ? basename(local) : "YouTube Video";
        let duration: number | null = null;
        let channel = "";
        let inputForFrames = local || params.url;
        let transcript = "";

        let transcriptSource = "";

        if (yt) {
          onUpdate?.({ content: [{ type: "text", text: "Reading YouTube metadata…" }] });
          const info = await getYouTubeInfo(params.url, signal);
          title = info.title ?? title;
          duration = info.duration;
          channel = info.channel ?? "";
          if (mode !== "transcript") {
            inputForFrames = await getYouTubeStreamUrl(params.url, signal);
          }
          if (includeTranscript) {
            onUpdate?.({ content: [{ type: "text", text: "Extracting YouTube captions…" }] });
            transcript = await extractYouTubeTranscript(params.url, workDir, signal);
            transcriptSource = transcript ? "captions" : "";
            if (!transcript) {
              const whisper = getWhisperConfig();
              if (whisper) {
                onUpdate?.({ content: [{ type: "text", text: `No captions found. Transcribing audio with ${whisper.provider} Whisper…` }] });
                const audioFile = await downloadYouTubeAudio(params.url, workDir, signal);
                if (audioFile) {
                  const result = await transcribeWithWhisper(audioFile, signal);
                  transcript = result.text;
                  transcriptSource = result.provider;
                }
              }
            }
          }
        } else if (local) {
          duration = await getLocalDuration(local, signal);
          if (includeTranscript) {
            const whisper = getWhisperConfig();
            if (whisper) {
              onUpdate?.({ content: [{ type: "text", text: `Transcribing local video audio with ${whisper.provider} Whisper…` }] });
              const audioFile = join(workDir, "local-audio.mp3");
              await extractAudioForWhisper(local, audioFile, signal);
              const result = await transcribeWithWhisper(audioFile, signal);
              transcript = result.text;
              transcriptSource = result.provider;
            }
          }
        }

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        const frameTimes = mode === "transcript" ? [] : sampleTimestamps(duration, range, requestedFrames);
        const extractedFrames: Array<{ timestamp: string; file: string }> = [];

        for (let i = 0; i < frameTimes.length; i++) {
          const seconds = frameTimes[i];
          onUpdate?.({ content: [{ type: "text", text: `Extracting frame ${i + 1}/${frameTimes.length} at ${formatDuration(seconds)}…` }] });
          const outFile = join(workDir, `frame-${String(i + 1).padStart(2, "0")}-${seconds}.jpg`);
          const buffer = await extractFrame(inputForFrames, seconds, outFile, signal);
          content.push({ type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" });
          content.push({ type: "text", text: `Frame at ${formatDuration(seconds)}` });
          extractedFrames.push({ timestamp: formatDuration(seconds), file: outFile });
        }

        const summary = [
          `# ${title}`,
          yt ? `Source: ${params.url}` : `File: ${local}`,
          channel ? `Channel: ${channel}` : undefined,
          duration !== null ? `Duration: ${formatDuration(duration)}` : undefined,
          params.prompt ? `Question: ${params.prompt}` : undefined,
          extractedFrames.length > 0 ? `Frames extracted: ${extractedFrames.map((f) => f.timestamp).join(", ")}` : undefined,
          transcript ? `\n## Transcript (${transcriptSource || "unknown"})\n` + truncate(transcript, 60_000) : includeTranscript ? "\n[No transcript found. Add GROQ_API_KEY or OPENAI_API_KEY for Whisper fallback, or use focused frames.]" : undefined,
          params.keepFiles ? `\nWorking directory kept: ${workDir}` : undefined,
        ].filter(Boolean).join("\n");

        content.push({ type: "text", text: summary });
        cleanup = !params.keepFiles;
        return { content, details: { url: params.url, title, duration, channel, frameCount: extractedFrames.length, frames: extractedFrames, hasTranscript: transcript.length > 0, transcriptSource, workDir: params.keepFiles ? workDir : undefined } };
      } finally {
        if (cleanup) rmSync(workDir, { recursive: true, force: true });
      }
    },
  });

  pi.registerTool({
    name: "github_fetch",
    label: "GitHub Fetch",
    description: "Fetch GitHub repo/blob/tree content. Clones repos locally for agent inspection when possible.",
    promptSnippet: "Fetch or clone GitHub repository content for inspection",
    promptGuidelines: ["Use github_fetch for GitHub URLs instead of web_fetch so the agent gets real files instead of rendered HTML."],
    parameters: githubFetchSchema,
    async execute(_id, params: GithubFetchParams, signal) {
      const parsed = parseGithubUrl(params.url);
      const cloneRoot = join(tmpdir(), "pi-github-fetch");
      const target = join(cloneRoot, `${parsed.owner}-${parsed.repo}`);
      if (!existsSync(target) || params.forceClone) {
        rmSync(target, { recursive: true, force: true });
        await execFileAsync("git", ["clone", "--depth", "1", `https://github.com/${parsed.owner}/${parsed.repo}.git`, target], { timeout: 60_000, encoding: "utf8", signal, maxBuffer: 10 * 1024 * 1024 });
      }
      const readme = ["README.md", "readme.md", "README.mdx"].map((f) => join(target, f)).find(existsSync);
      const tree = readdirSync(target).filter((f) => f !== ".git").slice(0, 80).join("\n");
      const readmeText = readme ? truncate(readFileSync(readme, "utf8"), 40_000) : "";
      const text = [`Repository cloned: ${target}`, `GitHub: https://github.com/${parsed.owner}/${parsed.repo}`, "", "## Top-level files", tree, readmeText ? "\n## README\n" + readmeText : ""].join("\n");
      return { content: [{ type: "text", text }], details: { owner: parsed.owner, repo: parsed.repo, path: target, readme } };
    },
  });
}
