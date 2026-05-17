import { spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'

const ROOT = path.join(os.homedir(), '.pi', 'agent', 'pi-workers')
const RUNS = path.join(ROOT, 'runs')
const GLOBAL_WORKERS_MAP = path.join(ROOT, 'WORKERS.md')
const CONFIG_PATH = path.join(ROOT, 'config.json')
const SESSION_PREFIX = 'piw-'
const PREVIEW_LINES = 80

const DEFAULT_ROLE_MODELS = {
  scout: 'opencode-go/deepseek-v4-flash',
  researcher: 'opencode-go/kimi-k2.6',
  planner: 'opencode-go/glm-5.1',
  reviewer: 'opencode-go/glm-5.1',
  worker: 'current',
} satisfies Record<Role, string | null>

const DEFAULT_WORKERS_MAP = `# Pi Workers Map

Visible tmux-backed Pi workers use this file as their routing map. Project-local worker maps override these defaults when present.

## General rules

- Stay in your assigned role.
- Read only the files needed for the task; do not bulk-load the whole repo.
- Prefer file paths, commands, and evidence over vague summaries.
- Do not edit project files unless your role/task explicitly allows it.
- Always write your final handoff to the run's handoff.md file before finishing.

## scout

Read:
- AGENTS.md / CLAUDE.md / README.md when present
- package manifests and config files when useful
- relevant source files, imports, tests, docs

Skip:
- node_modules, dist, build, .next, logs, large generated files

Output:
- concise architecture/context summary
- key files and why they matter
- risks, unknowns, and suggested next questions

## researcher

Read/search:
- official docs and primary sources first
- local project constraints when relevant

Output:
- cited sources/URLs or file paths
- practical implications
- confidence level and gaps

## planner

Read:
- request, relevant context, likely implementation files
- tests and validation paths

Output:
- concrete step-by-step plan
- files likely to change
- validation contract
- risks and open decisions

## reviewer

Read:
- current git diff and changed files
- related tests/docs/callers

Output:
- severity-ranked findings
- file/line evidence
- smallest safe fixes
- validation gaps

## worker

Read:
- approved scope and relevant context
- existing patterns before editing

Output:
- changed files
- commands run and results
- validation evidence
- what remains unresolved
`

type Role = 'scout' | 'researcher' | 'planner' | 'reviewer' | 'worker'
type WorkerRecord = {
  id: string
  role: Role
  task: string
  cwd: string
  tmuxSession: string
  runDir: string
  createdAt: string
  globalMapPath: string
  projectMapPaths: string[]
  handoffPath: string
  requestedModel: string | null
  resolvedModel: string | null
  modelSource: 'role-default' | 'explicit' | 'current' | 'default'
}

type WorkerConfig = {
  roleModels?: Partial<Record<Role, string | null>>
}

type ModelLike = { provider?: string; id?: string }

const ROLE_PROMPTS: Record<Role, string> = {
  scout: `You are a Pi Worker: scout.\n\nMap local project context quickly. Read relevant files, follow imports and docs, and return concise findings with file paths. Do not edit project files unless explicitly asked. You may write your required handoff file in the run directory.`,
  researcher: `You are a Pi Worker: researcher.\n\nResearch the question using available web/docs/local resources. Prefer primary sources and cite URLs or file paths. Return a concise brief with confidence and gaps. Do not edit project files. You may write your required handoff file in the run directory.`,
  planner: `You are a Pi Worker: planner.\n\nTurn the request and available context into a concrete implementation plan. Identify files, risks, validation, and open questions. Do not edit project files. You may write your required handoff file in the run directory.`,
  reviewer: `You are a Pi Worker: reviewer.\n\nReview the target critically. Inspect actual files/diffs directly. Report evidence-backed findings with severity and file/line references. Do not edit project files unless explicitly asked. You may write your required handoff file in the run directory.`,
  worker: `You are a Pi Worker: worker.\n\nImplement the requested task in this separate Pi session. Make focused changes, validate them, and summarize changed files, commands run, results, and unresolved decisions.`,
}

const ROLE_ALIASES: Record<string, Role> = {
  scout: 'scout',
  research: 'researcher',
  researcher: 'researcher',
  plan: 'planner',
  planner: 'planner',
  review: 'reviewer',
  reviewer: 'reviewer',
  implement: 'worker',
  worker: 'worker',
  work: 'worker',
}

function safeSlug(input: string, max = 36): string {
  const slug = input.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return (slug || 'worker').slice(0, max)
}

function shortId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function execFile(command: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawnChild(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => resolve({ stdout, stderr: error.message, code: 127 }))
    child.on('close', (code) => resolve({ stdout, stderr, code }))
  })
}

async function ensureRoot() {
  await mkdir(RUNS, { recursive: true })
  if (!existsSync(GLOBAL_WORKERS_MAP)) await writeFile(GLOBAL_WORKERS_MAP, DEFAULT_WORKERS_MAP, 'utf8')
  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify({ roleModels: DEFAULT_ROLE_MODELS }, null, 2), 'utf8')
  }
}

async function readConfig(): Promise<WorkerConfig> {
  await ensureRoot()
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as WorkerConfig
  } catch {
    return { roleModels: DEFAULT_ROLE_MODELS }
  }
}

function currentModelId(ctx: ExtensionContext): string | null {
  const model = (ctx as ExtensionContext & { model?: ModelLike }).model
  if (!model?.id) return null
  return model.provider ? `${model.provider}/${model.id}` : model.id
}

async function modelForRole(role: Role, explicitModel: string | null | undefined, ctx: ExtensionContext): Promise<{ requestedModel: string | null; resolvedModel: string | null; modelSource: WorkerRecord['modelSource'] }> {
  if (explicitModel) {
    const normalized = explicitModel.trim()
    if (/^(default|router|none)$/i.test(normalized)) return { requestedModel: normalized, resolvedModel: null, modelSource: 'default' }
    if (/^current$/i.test(normalized)) return { requestedModel: normalized, resolvedModel: currentModelId(ctx), modelSource: 'current' }
    return { requestedModel: normalized, resolvedModel: normalized, modelSource: 'explicit' }
  }

  const config = await readConfig()
  const roleModel = config.roleModels?.[role] ?? DEFAULT_ROLE_MODELS[role]
  if (!roleModel || /^(default|router|none)$/i.test(roleModel)) return { requestedModel: roleModel ?? null, resolvedModel: null, modelSource: 'default' }
  if (/^current$/i.test(roleModel)) return { requestedModel: roleModel, resolvedModel: currentModelId(ctx), modelSource: 'current' }
  return { requestedModel: roleModel, resolvedModel: roleModel, modelSource: 'role-default' }
}

async function tmuxAvailable(): Promise<boolean> {
  const result = await execFile('bash', ['-lc', 'command -v tmux >/dev/null 2>&1'])
  return result.code === 0
}

async function hasTmuxSession(session: string): Promise<boolean> {
  const result = await execFile('tmux', ['has-session', '-t', session])
  return result.code === 0
}

async function records(): Promise<WorkerRecord[]> {
  await ensureRoot()
  const dirs = await readdir(RUNS, { withFileTypes: true }).catch(() => [])
  const out: WorkerRecord[] = []
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const file = path.join(RUNS, dir.name, 'worker.json')
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<WorkerRecord>
      if (!raw.id || !raw.role || !raw.task || !raw.cwd || !raw.tmuxSession || !raw.runDir || !raw.createdAt) continue
      out.push({
        id: raw.id,
        role: raw.role,
        task: raw.task,
        cwd: raw.cwd,
        tmuxSession: raw.tmuxSession,
        runDir: raw.runDir,
        createdAt: raw.createdAt,
        globalMapPath: raw.globalMapPath ?? GLOBAL_WORKERS_MAP,
        projectMapPaths: raw.projectMapPaths ?? [],
        handoffPath: raw.handoffPath ?? path.join(raw.runDir, 'handoff.md'),
        requestedModel: raw.requestedModel ?? null,
        resolvedModel: raw.resolvedModel ?? null,
        modelSource: raw.modelSource ?? 'default',
      })
    } catch {}
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function resolveRole(value: string): Role | null {
  return ROLE_ALIASES[value.toLowerCase()] ?? null
}

function projectWorkerMaps(cwd: string): string[] {
  const candidates = [
    path.join(cwd, '.pi', 'workers.md'),
    path.join(cwd, 'WORKERS.md'),
    path.join(cwd, 'AGENTS.md'),
    path.join(cwd, 'CLAUDE.md'),
  ]
  return candidates.filter((candidate) => existsSync(candidate))
}

function formatPathList(paths: string[]): string {
  if (paths.length === 0) return '- none found'
  return paths.map((p) => `- ${p}`).join('\n')
}

async function spawnWorker(role: Role, task: string, cwd: string, ctx: ExtensionContext, explicitModel?: string | null): Promise<WorkerRecord> {
  await ensureRoot()
  if (!(await tmuxAvailable())) throw new Error('tmux is not installed or not on PATH.')

  const id = shortId()
  const tmuxSession = `${SESSION_PREFIX}${safeSlug(role)}-${id}`
  const runDir = path.join(RUNS, id)
  await mkdir(runDir, { recursive: true })

  const systemPath = path.join(runDir, 'system.md')
  const promptPath = path.join(runDir, 'prompt.md')
  const transcriptPath = path.join(runDir, 'transcript.ansi')
  const handoffPath = path.join(runDir, 'handoff.md')
  const runnerPath = path.join(runDir, 'run.sh')
  const projectMapPaths = projectWorkerMaps(cwd)
  const modelSelection = await modelForRole(role, explicitModel, ctx)

  const prompt = `# Pi Worker Task\n\nRole: ${role}\nModel: ${modelSelection.resolvedModel ?? 'default/current Pi router'} (${modelSelection.modelSource})\nCWD: ${cwd}\nRun dir: ${runDir}\nTranscript: ${transcriptPath}\nHandoff file: ${handoffPath}\n\n## Routing context\n\nRead the global worker map first:\n- ${GLOBAL_WORKERS_MAP}\n\nThen read the project worker map(s) that exist. Project rules override global rules:\n${formatPathList(projectMapPaths)}\n\nUse the routing rules for your role. Read only the context needed for this task.\n\n## Task\n\n${task}\n\n## Required final handoff\n\nBefore finishing, write your final handoff to exactly this path:\n\n${handoffPath}\n\nUse this structure:\n\n# Pi Worker Handoff — ${role}\n\n## Summary\n\n## Files inspected\n\n## Files changed\n\n## Findings / decisions\n\n## Validation\n\n## Open questions / next steps\n`

  await writeFile(systemPath, ROLE_PROMPTS[role], 'utf8')
  await writeFile(promptPath, prompt, 'utf8')
  await writeFile(transcriptPath, '', 'utf8')
  await writeFile(handoffPath, `# Pi Worker Handoff — ${role}\n\nStatus: pending\n\nWorker: ${id}\nTask: ${task}\n`, 'utf8')
  await writeFile(
    runnerPath,
    `#!/bin/zsh\ncd ${JSON.stringify(cwd)} || exit 1\nSYSTEM_PROMPT=$(cat ${JSON.stringify(systemPath)})\necho "[pi-worker] ${id} role=${role} cwd=$(pwd)"\necho "[pi-worker] prompt: ${promptPath}"\necho "[pi-worker] model: ${modelSelection.resolvedModel ?? 'default/current Pi router'} (${modelSelection.modelSource})"\necho "[pi-worker] handoff: ${handoffPath}"\necho "[pi-worker] transcript: ${transcriptPath}"\npi ${modelSelection.resolvedModel ? `--model ${JSON.stringify(modelSelection.resolvedModel)} ` : ''}--append-system-prompt "$SYSTEM_PROMPT" ${JSON.stringify(`@${promptPath}`)}\nEXIT_CODE=$?\necho "[pi-worker] ${id} finished with exit code $EXIT_CODE"\ndate -u +'%Y-%m-%dT%H:%M:%SZ' > ${JSON.stringify(path.join(runDir, 'completed'))}\necho $EXIT_CODE > ${JSON.stringify(path.join(runDir, 'exit-code'))}\nif [ -f ${JSON.stringify(handoffPath)} ]; then\n  STATUS_FILE=$(cat ${JSON.stringify(handoffPath)} | head -5)\n  osascript -e 'display notification "Pi worker finished: ${role} (${id})" with title "Pi Worker"' 2>/dev/null || true\nelse\n  osascript -e 'display notification "Pi worker finished: ${role} (${id}) — no handoff" with title "Pi Worker"' 2>/dev/null || true\nfi\nexit $EXIT_CODE\n`,
    { encoding: 'utf8', mode: 0o700 }
  )

  const record: WorkerRecord = {
    id,
    role,
    task,
    cwd,
    tmuxSession,
    runDir,
    createdAt: new Date().toISOString(),
    globalMapPath: GLOBAL_WORKERS_MAP,
    projectMapPaths,
    handoffPath,
    requestedModel: modelSelection.requestedModel,
    resolvedModel: modelSelection.resolvedModel,
    modelSource: modelSelection.modelSource,
  }
  await writeFile(path.join(runDir, 'worker.json'), JSON.stringify(record, null, 2), 'utf8')

  const created = await execFile('tmux', ['new-session', '-d', '-s', tmuxSession, '-n', role, '-c', cwd, runnerPath])
  if (created.code !== 0) throw new Error(created.stderr || `tmux new-session failed with ${created.code}`)

  // Capture the visible terminal stream to disk while preserving full observability in tmux.
  await execFile('tmux', ['pipe-pane', '-o', '-t', tmuxSession, `cat >> ${JSON.stringify(transcriptPath)}`])
  return record
}

async function isCompleted(runDir: string): Promise<boolean> {
  return existsSync(path.join(runDir, 'completed'))
}

async function statusLines(): Promise<string> {
  const items = await records()
  if (items.length === 0) return 'No Pi workers yet.'
  const lines = await Promise.all(items.map(async (r) => {
    const alive = await hasTmuxSession(r.tmuxSession)
    const completed = await isCompleted(r.runDir)
    const handoffExists = existsSync(r.handoffPath)
    const status = alive ? 'running' : (completed ? 'done' : 'stopped')
    return `${status}  ${r.id}  ${r.role}  ${r.tmuxSession}${handoffExists ? '  handoff:yes' : '  handoff:no'}  model:${r.resolvedModel ?? 'default'} (${r.modelSource})\n  cwd: ${r.cwd}\n  task: ${r.task.slice(0, 120)}\n  attach: tmux attach -t ${r.tmuxSession}\n  handoff: ${r.handoffPath}\n  transcript: ${path.join(r.runDir, 'transcript.ansi')}`
  }))
  return lines.join('\n\n')
}

async function findRecord(idOrSession: string): Promise<WorkerRecord | undefined> {
  const all = await records()
  return all.find((r) => r.id.startsWith(idOrSession) || r.tmuxSession === idOrSession || r.tmuxSession.endsWith(idOrSession))
}

function parseSpawnArgs(args: string): { role: Role; task: string; model?: string } | null {
  const match = args.trim().match(/^(?:spawn\s+)?(scout|research|researcher|plan|planner|review|reviewer|implement|worker|work)\b\s*[:\-]?\s*([\s\S]+)$/i)
  if (!match) return null
  const role = resolveRole(match[1])
  let rest = match[2]?.trim() ?? ''
  let model: string | undefined
  const modelMatch = rest.match(/^--model(?:=|\s+)(\S+)\s+([\s\S]+)$/i) ?? rest.match(/^-m(?:=|\s+)(\S+)\s+([\s\S]+)$/i)
  if (modelMatch) {
    model = modelMatch[1]
    rest = modelMatch[2].trim()
  }
  const task = rest.trim()
  if (!role || !task) return null
  return { role, task, model }
}

async function handoffSummary(record: WorkerRecord): Promise<string> {
  if (!existsSync(record.handoffPath)) {
    return `No handoff.md yet.\nAttach: tmux attach -t ${record.tmuxSession}\nTranscript: ${path.join(record.runDir, 'transcript.ansi')}`
  }
  const raw = await readFile(record.handoffPath, 'utf8')
  const lines = raw.split('\n')
  const preview = lines.slice(0, PREVIEW_LINES).join('\n')
  const suffix = lines.length > PREVIEW_LINES ? `\n\n[Preview truncated to ${PREVIEW_LINES} lines. Full handoff: ${record.handoffPath}]` : ''
  return `Handoff: ${record.handoffPath}\n\n${preview}${suffix}`
}

async function handleTextCommand(text: string, ctx: ExtensionContext): Promise<string> {
  const trimmed = text.trim()
  const [, rest = ''] = trimmed.match(/^pi\s+worker(?:s)?\s*(.*)$/i) ?? []
  if (!rest || /^help$/i.test(rest)) {
    return `Pi Workers commands:\n- pi worker spawn <scout|researcher|planner|reviewer|worker> <task>\n- pi worker scout --model opencode-go/kimi-k2.6 <task>\n- pi worker scout --model current <task>\n- pi worker scout <task>\n- pi worker research <task>\n- pi worker plan <task>\n- pi worker review <task>\n- pi worker implement <task>\n- pi worker list\n- pi worker attach <id>\n- pi worker kill <id>\n- pi worker handoff <id>\n- pi worker wait <id>    (blocks until worker finishes, then returns handoff)\n- pi worker transcript <id>\n\nGlobal routing map: ${GLOBAL_WORKERS_MAP}\nModel config: ${CONFIG_PATH}\nWorkers send macOS notification on completion.`
  }

  if (/^list$/i.test(rest)) return statusLines()

  const spawnArgs = parseSpawnArgs(rest)
  if (spawnArgs) {
    const record = await spawnWorker(spawnArgs.role, spawnArgs.task, ctx.cwd, ctx, spawnArgs.model)
    return `Spawned Pi worker ${record.id} (${record.role}).\nAttach: tmux attach -t ${record.tmuxSession}\nRun dir: ${record.runDir}\nHandoff: ${record.handoffPath}\nModel: ${record.resolvedModel ?? 'default/current Pi router'} (${record.modelSource})\nGlobal map: ${record.globalMapPath}\nProject maps: ${record.projectMapPaths.length ? record.projectMapPaths.join(', ') : 'none'}`
  }

  const attach = rest.match(/^attach\s+(.+)$/i)
  if (attach) {
    const record = await findRecord(attach[1].trim())
    if (!record) return `No worker found for ${attach[1].trim()}`
    return `Attach with:\n\ntmux attach -t ${record.tmuxSession}`
  }

  const kill = rest.match(/^kill\s+(.+)$/i)
  if (kill) {
    const record = await findRecord(kill[1].trim())
    if (!record) return `No worker found for ${kill[1].trim()}`
    const result = await execFile('tmux', ['kill-session', '-t', record.tmuxSession])
    return result.code === 0 ? `Killed ${record.tmuxSession}` : `Kill failed: ${result.stderr}`
  }

  const wait = rest.match(/^wait\s+(.+)$/i)
  if (wait) {
    const record = await findRecord(wait[1].trim())
    if (!record) return `No worker found for ${wait[1].trim()}`
    const completedPath = path.join(record.runDir, 'completed')
    while (!existsSync(completedPath)) {
      const alive = await hasTmuxSession(record.tmuxSession)
      if (!alive && !existsSync(completedPath)) {
        await new Promise((r) => setTimeout(r, 500))
        if (!existsSync(completedPath)) return `Worker ${record.id} stopped without completing. Attach: tmux attach -t ${record.tmuxSession}\nHandoff: ${record.handoffPath}`
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    return handoffSummary(record)
  }

  const handoff = rest.match(/^handoff\s+(.+)$/i)
  if (handoff) {
    const record = await findRecord(handoff[1].trim())
    if (!record) return `No worker found for ${handoff[1].trim()}`
    return handoffSummary(record)
  }

  const transcript = rest.match(/^(?:transcript|output)\s+(.+)$/i)
  if (transcript) {
    const record = await findRecord(transcript[1].trim())
    if (!record) return `No worker found for ${transcript[1].trim()}`
    return `Transcript: ${path.join(record.runDir, 'transcript.ansi')}\nPrompt: ${path.join(record.runDir, 'prompt.md')}\nHandoff: ${record.handoffPath}`
  }

  return `Unrecognized Pi Workers command. Try: pi worker help`
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('pi-worker', {
    description: 'Spawn/list/attach/kill visible tmux-backed Pi worker sessions',
    handler: async (args, ctx) => {
      try {
        const result = await handleTextCommand(`pi worker ${args}`, ctx)
        ctx.ui.notify(result, 'info')
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.on('input', async (event, ctx) => {
    if (!/^pi\s+worker(?:s)?\b/i.test(event.text.trim())) return { action: 'continue' }
    try {
      const result = await handleTextCommand(event.text, ctx)
      ctx.ui.notify(result, 'info')
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    }
    return { action: 'handled' }
  })

  pi.registerTool({
    name: 'pi_worker',
    label: 'Pi Worker',
    description: 'Spawn or inspect visible tmux-backed Pi worker sessions. Output is truncated to command/status text; full worker transcript and handoff are saved under ~/.pi/agent/pi-workers/runs/.',
    promptSnippet: 'Spawn/list/attach/kill visible tmux-backed Pi worker sessions',
    promptGuidelines: [
      'Use pi_worker when the user asks to spawn a visible Pi worker such as scout, researcher, planner, reviewer, or worker.',
      'pi_worker creates real tmux sessions; tell the user the tmux attach command so they can observe/control the worker directly.',
      'Use pi_worker handoff to inspect a completed worker summary instead of scraping the full transcript.',
    ],
    parameters: Type.Object({
      action: StringEnum(['spawn', 'list', 'attach', 'kill', 'transcript', 'handoff'] as const),
      role: Type.Optional(StringEnum(['scout', 'researcher', 'planner', 'reviewer', 'worker'] as const)),
      task: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === 'list') return { content: [{ type: 'text', text: await statusLines() }] }
      if (params.action === 'spawn') {
        if (!params.role || !params.task) throw new Error('spawn requires role and task')
        const role = resolveRole(params.role)
        if (!role) throw new Error(`Unknown role: ${params.role}`)
        const record = await spawnWorker(role, params.task, ctx.cwd, ctx, params.model)
        return { content: [{ type: 'text', text: `Spawned Pi worker ${record.id} (${record.role}).\nAttach: tmux attach -t ${record.tmuxSession}\nRun dir: ${record.runDir}\nHandoff: ${record.handoffPath}\nModel: ${record.resolvedModel ?? 'default/current Pi router'} (${record.modelSource})` }], details: record }
      }
      if (!params.id) throw new Error(`${params.action} requires id`)
      const commandText = `pi worker ${params.action} ${params.id}`
      return { content: [{ type: 'text', text: await handleTextCommand(commandText, ctx) }] }
    },
  })

  pi.on('session_start', (_event, ctx) => {
    ensureRoot().catch(() => {})
    if (ctx.hasUI) ctx.ui.setStatus('pi-workers', 'pi-workers ready')
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus('pi-workers', undefined)
  })
}
