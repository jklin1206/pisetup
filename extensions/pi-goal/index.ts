import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import { Type } from 'typebox'

const ROOT = path.join(os.homedir(), '.pi', 'agent', 'goals')
const WORKERS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'pi-workers')

type GoalRole = 'scout' | 'researcher' | 'planner' | 'reviewer' | 'worker'
type GoalStatus = 'planning' | 'executing' | 'evaluating' | 'done' | 'blocked' | 'paused'

type GoalRecord = {
  id: string
  goal: string
  verification: string
  constraints: string
  status: GoalStatus
  /** Coordinator model for text evaluation */
  model: string
  /** Multimodal model for visual evaluation (screenshots/video) */
  visionModel: string
  maxIterations: number
  currentIteration: number
  workerIds: string[]
  createdAt: string
  updatedAt: string
}

type EvidenceItem = {
  path: string
  type: 'screenshot' | 'recording' | 'screencast' | 'log' | 'diff'
  label: string
  capturedAt: string
  description?: string
}

type IterationRecord = {
  iteration: number
  role: GoalRole
  workerId: string
  workerTask: string
  startedAt: string
  completedAt?: string
  handoffPath?: string
  assessment?: string
  goalMet?: boolean
  evidence: EvidenceItem[]
  /** Multimodal evaluation notes from the vision model */
  visualNotes?: string
}

type SchedulerPhase = 'idle' | 'scouting' | 'implementing' | 'reviewing' | 'done' | 'blocked'
type SchedulerState = {
  goalId: string
  phase: SchedulerPhase
  currentRun?: ScheduledRun
  scoutHandoff?: string
  workerHandoff?: string
  reviewerHandoff?: string
  updatedAt: string
}

type ScheduledRun = {
  id: string
  role: GoalRole
  tmuxSession: string
  runDir: string
  handoffPath: string
  completedPath: string
  exitCodePath: string
  task: string
  createdAt: string
}

const DEFAULT_COORDINATOR_MODEL = 'opencode-go/deepseek-v4-flash'
// Vision-capable model for screenshot/video evaluation
const DEFAULT_VISION_MODEL = 'anthropic/claude-sonnet-4'

const ROLE_SUGGESTIONS: Record<string, GoalRole[]> = {
  audit: ['scout', 'reviewer'],
  research: ['researcher'],
  plan: ['planner'],
  implement: ['planner', 'reviewer'],
  review: ['reviewer'],
  fix: ['planner', 'reviewer'],
  cleanup: ['scout', 'reviewer'],
  organize: ['scout', 'reviewer'],
  migrate: ['planner', 'reviewer'],
  explore: ['scout'],
  catalog: ['researcher', 'reviewer'],
  build: ['planner', 'reviewer'],
  default: [],
}

function shortId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function execCmd(command: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30000, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error: Error) => resolve({ stdout, stderr: error.message, code: 127 }))
    child.on('close', (code: number | null) => resolve({ stdout, stderr, code }))
  })
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true })
}

async function readGoal(id: string): Promise<GoalRecord | null> {
  try {
    return JSON.parse(await readFile(path.join(ROOT, id, 'goal.json'), 'utf8')) as GoalRecord
  } catch {
    return null
  }
}

async function writeGoal(goal: GoalRecord) {
  await ensureDir(path.join(ROOT, goal.id))
  goal.updatedAt = new Date().toISOString()
  await writeFile(path.join(ROOT, goal.id, 'goal.json'), JSON.stringify(goal, null, 2), 'utf8')
}

async function readIterations(id: string): Promise<IterationRecord[]> {
  try {
    return JSON.parse(await readFile(path.join(ROOT, id, 'iterations.json'), 'utf8')) as IterationRecord[]
  } catch {
    return []
  }
}

async function writeIterations(id: string, iterations: IterationRecord[]) {
  await writeFile(path.join(ROOT, id, 'iterations.json'), JSON.stringify(iterations, null, 2), 'utf8')
}

function suggestRoles(goalText: string): GoalRole[] {
  const lower = goalText.toLowerCase()
  for (const [keyword, roles] of Object.entries(ROLE_SUGGESTIONS)) {
    if (keyword !== 'default' && lower.includes(keyword)) return roles
  }
  return ROLE_SUGGESTIONS.default
}

function inferVerification(goal: string): string {
  const evidence = evidenceRequirementText(goal)
  if (/test|pass|green|failing/i.test(goal)) return `All tests pass with no regressions. ${evidence}`
  if (/fix|bug|error|broken/i.test(goal)) return `The reported issue is resolved. ${evidence}`
  if (/clean|organize|audit|conflict/i.test(goal)) return `All identified conflicts are resolved. ${evidence}`
  if (/catalog|populate|document/i.test(goal)) return `All target items are cataloged and cross-linked. ${evidence}`
  if (/implement|build|create|add/i.test(goal)) return `Implementation matches the spec. ${evidence}`
  if (/design|ui|layout|page|site/i.test(goal)) return `Visual matches the design intent. ${evidence}`
  if (/deploy|launch|release/i.test(goal)) return `Deployed and accessible. ${evidence}`
  if (/research|investigate|find/i.test(goal)) return `Research findings are documented with sources and gaps identified. ${evidence}`
  return `The objective is complete and verified. ${evidence}`
}

function requiresRecording(goalText: string): boolean {
  return /\b(flow|interactive|interaction|click|form|submit|login|logout|sign[- ]?in|sign[- ]?up|onboard|checkout|purchase|payment|drag|drop|upload|download|modal|menu|dropdown|tab|wizard|multi[- ]?step|animation|transition|demo|walkthrough|video|recording|mobile app|web app|dashboard|ui|ux)\b/i.test(goalText)
}

function evidenceRequirementText(goalText: string): string {
  return requiresRecording(goalText)
    ? 'Completion requires at least one screenshot plus a screen recording of the interactive flow working end-to-end.'
    : 'Completion requires at least one screenshot showing the final working result.'
}

function evidenceBlockers(goal: GoalRecord, evidence: EvidenceItem[]): string[] {
  const screenshots = evidence.filter((e) => e.type === 'screenshot')
  const recordings = evidence.filter((e) => e.type === 'recording' || e.type === 'screencast')
  const blockers: string[] = []
  if (screenshots.length === 0) blockers.push('at least one screenshot is required before the goal can be marked done')
  if (requiresRecording(`${goal.goal} ${goal.verification}`) && recordings.length === 0) blockers.push('this appears to involve an interactive flow, so a screen recording is required before the goal can be marked done')
  return blockers
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function evidenceDir(goalId: string, iteration?: number): string {
  if (iteration !== undefined) return path.join(ROOT, goalId, 'evidence', `iteration-${iteration}`)
  return path.join(ROOT, goalId, 'evidence')
}

async function captureScreenshot(outputPath: string): Promise<boolean> {
  // macOS screencapture
  const result = await execCmd('screencapture', ['-x', '-t', 'png', outputPath])
  return result.code === 0
}

async function captureWindowScreenshot(outputPath: string): Promise<boolean> {
  // macOS screencapture - interactive window selection
  const result = await execCmd('screencapture', ['-x', '-w', '-t', 'png', outputPath])
  return result.code === 0
}

async function startScreenRecording(outputPath: string): Promise<string | null> {
  // macOS: start recording using ffmpeg if available, otherwise screencapture
  // We return a process reference so recording can be stopped
  const ffmpegCheck = await execCmd('which', ['ffmpeg'])
  if (ffmpegCheck.code !== 0) return null

  // Use ffmpeg to record screen (macOS requires screen recording permission)
  const child = spawn('ffmpeg', [
    '-f', 'avfoundation', '-i', '1',
    '-r', '15',
    '-pix_fmt', 'yuv420p',
    '-y', outputPath
  ], { stdio: 'ignore', detached: true })
  child.unref()
  return child.pid?.toString() ?? null
}

async function stopScreenRecording(pid: string): Promise<void> {
  try {
    process.kill(Number(pid), 'SIGINT')
  } catch { /* may already be dead */ }
}

function schedulerPath(goalId: string): string {
  return path.join(ROOT, goalId, 'scheduler.json')
}

async function readScheduler(goalId: string): Promise<SchedulerState> {
  try {
    return JSON.parse(await readFile(schedulerPath(goalId), 'utf8')) as SchedulerState
  } catch {
    return { goalId, phase: 'idle', updatedAt: new Date().toISOString() }
  }
}

async function writeScheduler(state: SchedulerState) {
  state.updatedAt = new Date().toISOString()
  await writeFile(schedulerPath(state.goalId), JSON.stringify(state, null, 2), 'utf8')
}

async function hasActiveScheduledGoalRun(): Promise<boolean> {
  const goals = await listGoals()
  for (const goal of goals) {
    const state = await readScheduler(goal.id)
    if (!state.currentRun) continue
    if (existsSync(state.currentRun.completedPath)) continue
    const result = await execCmd('tmux', ['has-session', '-t', state.currentRun.tmuxSession], { timeout: 5000 })
    if (result.code === 0) return true
  }
  return false
}

function scheduledRunsDir(goalId: string): string {
  return path.join(ROOT, goalId, 'runs')
}

async function spawnScheduledRun(goal: GoalRecord, role: GoalRole, task: string, cwd: string): Promise<ScheduledRun> {
  const id = shortId()
  const runDir = path.join(scheduledRunsDir(goal.id), id)
  await ensureDir(runDir)
  const promptPath = path.join(runDir, 'prompt.md')
  const handoffPath = path.join(runDir, 'handoff.md')
  const completedPath = path.join(runDir, 'completed')
  const exitCodePath = path.join(runDir, 'exit-code')
  const transcriptPath = path.join(runDir, 'transcript.ansi')
  const runnerPath = path.join(runDir, 'run.sh')
  const tmuxSession = `goal-${role}-${id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const prompt = `# Goal Scheduler Run

Goal: ${goal.goal}
Verification: ${goal.verification}
Constraints: ${goal.constraints || 'none'}
Role: ${role}

${task}

## Required handoff
Write your final handoff to exactly:
${handoffPath}

Include: summary, files inspected, files changed, validation, visual evidence paths, whether goal is met, and next recommended action.`
  await writeFile(promptPath, prompt, 'utf8')
  await writeFile(handoffPath, `# Scheduled Goal Handoff — ${role}\n\nStatus: pending\n`, 'utf8')
  await writeFile(transcriptPath, '', 'utf8')
  await writeFile(runnerPath, `#!/bin/zsh
cd ${JSON.stringify(cwd)} || exit 1
echo "[goal-scheduler] ${goal.id} role=${role} run=${id}"
pi --model ${JSON.stringify(role === 'worker' ? goal.model : goal.model)} ${JSON.stringify(`@${promptPath}`)}
code=$?
date -u +'%Y-%m-%dT%H:%M:%SZ' > ${JSON.stringify(completedPath)}
echo $code > ${JSON.stringify(exitCodePath)}
osascript -e 'display notification "goal ${goal.id}: ${role} finished" with title "Goal Scheduler"' 2>/dev/null || true
exit $code
`, { encoding: 'utf8', mode: 0o700 })
  const created = await execCmd('tmux', ['new-session', '-d', '-s', tmuxSession, '-n', role, '-c', cwd, runnerPath])
  if (created.code !== 0) throw new Error(created.stderr || `tmux failed to start scheduled run`)
  await execCmd('tmux', ['pipe-pane', '-o', '-t', tmuxSession, `cat >> ${JSON.stringify(transcriptPath)}`])
  return { id, role, tmuxSession, runDir, handoffPath, completedPath, exitCodePath, task, createdAt: new Date().toISOString() }
}

async function schedulerTick(ctx: ExtensionContext) {
  const goals = await listGoals()
  const goal = goals.find((g) => g.status !== 'done' && g.status !== 'paused' && g.status !== 'blocked')
  if (!goal) return
  const state = await readScheduler(goal.id)
  const evDir = evidenceDir(goal.id, goal.currentIteration || 1)
  await ensureDir(evDir)

  if (state.currentRun && !existsSync(state.currentRun.completedPath)) return

  if (state.currentRun && existsSync(state.currentRun.completedPath)) {
    const handoff = existsSync(state.currentRun.handoffPath) ? await readFile(state.currentRun.handoffPath, 'utf8') : ''
    if (state.currentRun.role === 'scout') state.scoutHandoff = handoff
    if (state.currentRun.role === 'worker') state.workerHandoff = handoff
    if (state.currentRun.role === 'reviewer') state.reviewerHandoff = handoff
    state.currentRun = undefined
  }

  if (state.phase === 'idle') {
    goal.status = 'executing'
    goal.currentIteration = Math.max(goal.currentIteration, 1)
    await writeGoal(goal)
    const task = `Scout the codebase for agent navigability. Identify confusing structure, missing Markdown, unclear entry points, dead ends/loops, and exact minimal docs needed. Do not edit project files. Do not capture screenshots from inside this tmux worker; the coordinator captures visual evidence after workers finish. Evidence directory for coordinator use: ${evDir}.`
    state.currentRun = await spawnScheduledRun(goal, 'scout', task, ctx.cwd)
    state.phase = 'scouting'
    await writeScheduler(state)
    return
  }

  if (state.phase === 'scouting') {
    const task = `Using this scout handoff, implement the smallest useful Markdown/navigation improvements. Do not move/delete source files. Prefer root docs, folder READMEs, maps, and agent traversal guidance. Do not capture screenshots from inside this tmux worker; the coordinator captures visual evidence after workers finish. Evidence directory for coordinator use: ${evDir}.

Scout handoff:\n${state.scoutHandoff || '(missing)'}`
    state.currentRun = await spawnScheduledRun(goal, 'worker', task, ctx.cwd)
    state.phase = 'implementing'
    await writeScheduler(state)
    return
  }

  if (state.phase === 'implementing') {
    const task = `Review whether the documentation/navigation changes make the codebase easy for future agents to traverse. Inspect the diff and docs. Do not capture screenshots from inside this tmux worker; the coordinator captures visual evidence after workers finish. Evidence directory for coordinator use: ${evDir}. Mark GOAL_MET: yes/no/partial and list blockers.

Scout handoff:\n${state.scoutHandoff || ''}

Worker handoff:\n${state.workerHandoff || ''}`
    state.currentRun = await spawnScheduledRun(goal, 'reviewer', task, ctx.cwd)
    state.phase = 'reviewing'
    await writeScheduler(state)
    return
  }

  if (state.phase === 'reviewing') {
    const met = /GOAL_MET:\s*yes/i.test(state.reviewerHandoff || '') || /goal (?:is )?met/i.test(state.reviewerHandoff || '')
    goal.status = met ? 'done' : 'evaluating'
    await writeGoal(goal)
    state.phase = met ? 'done' : 'blocked'
    await writeScheduler(state)
    await execCmd('osascript', ['-e', `display notification "Goal ${goal.id} ${met ? 'done' : 'needs attention'}" with title "Goal Scheduler"`]).catch(() => {})
  }
}

// ─── Worker prompt enhancement: tells workers to capture visual evidence ───

function evidenceInstructions(goalId: string, iteration: number): string {
  const evDir = evidenceDir(goalId, iteration)
  return `
## Visual Evidence Requirements

This goal requires visual proof of completion. You MUST capture:

1. **Screenshots** of the working result at key states
   - Use: \`screencapture -x <path>\` for full screen
   - Use: \`screencapture -x -w <path>\` for a specific window
   - Save to: ${evDir}/

2. **Screen recording** if the goal involves interactive flows (forms, transitions, multi-step processes)
   - Start recording before demonstrating the flow
   - Save as: ${evDir}/demo.mp4

3. **Evidence manifest** — create ${evDir}/evidence.json listing every captured file with a label

### Naming convention
- \`screenshot-<step>-<N>.png\` — e.g., screenshot-initial-01.png, screenshot-final-01.png
- \`recording-<label>.mp4\` — e.g., recording-full-flow.mp4

### When to capture
- Before starting work (initial state)
- After each major step
- After work is complete (final state)
- Any errors or unexpected behavior

### Example
\`\`\`bash
mkdir -p "${evDir}"
screencapture -x "${evDir}/screenshot-before-01.png"
# ... do work ...
screencapture -x "${evDir}/screenshot-after-01.png"
screencapture -x "${evDir}/screenshot-after-02.png"
\`\`\`

The evaluation model (multimodal/vision-capable) will review your screenshots and recordings
to confirm the goal is actually achieved — not just that the code was written.
`
}

// ─── Multimodal evaluation prompt ───

function visualEvaluationPrompt(goal: GoalRecord, evidencePaths: string[]): string {
  const evidenceList = evidencePaths.length > 0
    ? evidencePaths.map((p) => `- ${p}`).join('\n')
    : 'No visual evidence captured yet.'

  return `You are evaluating whether a goal has been achieved using VISUAL EVIDENCE.

## Goal
${goal.goal}

## Verification Criteria
${goal.verification}

## Constraints
${goal.constraints || 'None specified'}

## Visual Evidence
${evidenceList}

## Your Task

Look at the screenshots and/or video provided. Evaluate:

1. **Completion**: Does the visual evidence show the goal is actually achieved?
   - Not "does the code exist" but "does it WORK as intended?"
   - Can you see the feature functioning correctly in the screenshots/recording?
   - At least one screenshot is required for every completed goal.
   - If the goal is interactive, a screen recording of the flow working end-to-end is required.

2. **Visual Quality**: Note any visual issues:
   - Layout problems, broken styling, misalignment
   - Poor responsiveness, clipped content, z-index issues
   - Accessibility concerns (contrast, font size, focus states)
   - Inconsistencies between states

3. **UX Flow**: If a recording or sequence of screenshots:
   - Does the user flow make sense?
   - Are transitions smooth?
   - Are error states handled?
   - Is the experience confusing in any way?

4. **Edge Cases Visible**: Can you see evidence of:
   - Loading states
   - Error handling
   - Empty states
   - Edge case data

## Output Format

Respond with:

COMPLETION: <percentage 0-100>
GOAL_MET: <yes|no|partial>
VISUAL_NOTES: <numbered list of visual/UX observations>
BLOCKERS: <any issues that prevent goal completion, or "none">
RECOMMENDATION: <what to do next — iterate, done, or blocked>

Be specific. Reference what you can actually see in the evidence. If the evidence
is insufficient, say so — don't guess.`
}

// ─── Command handlers ───

async function listGoals(): Promise<GoalRecord[]> {
  await ensureDir(ROOT)
  const dirs = await readdirSafe(ROOT)
  const goals: GoalRecord[] = []
  for (const dir of dirs) {
    const goal = await readGoal(dir)
    if (goal) goals.push(goal)
  }
  return goals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

async function collectEvidence(goalId: string, iteration?: number): Promise<EvidenceItem[]> {
  const evDir = iteration !== undefined ? evidenceDir(goalId, iteration) : evidenceDir(goalId)
  const items: EvidenceItem[] = []

  // Check for evidence manifest
  const manifestPath = path.join(evDir, 'evidence.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvidenceItem[]
      items.push(...manifest)
    } catch { /* empty */ }
  }

  // Scan directory for screenshots and recordings not in manifest
  if (existsSync(evDir)) {
    try {
      const files = await readdir(evDir)
      const knownPaths = new Set(items.map((i) => i.path))
      for (const file of files) {
        const fullPath = path.join(evDir, file)
        if (knownPaths.has(fullPath)) continue
        if (/screenshot.*\.png$/i.test(file)) {
          items.push({ path: fullPath, type: 'screenshot', label: file.replace(/\.\w+$/, ''), capturedAt: new Date().toISOString() })
        } else if (/recording.*\.(mp4|mov|webm|gif)$/i.test(file)) {
          items.push({ path: fullPath, type: 'recording', label: file.replace(/\.\w+$/, ''), capturedAt: new Date().toISOString() })
        } else if (/screencast.*\.(mp4|mov|webm|gif)$/i.test(file)) {
          items.push({ path: fullPath, type: 'screencast', label: file.replace(/\.\w+$/, ''), capturedAt: new Date().toISOString() })
        }
      }
    } catch { /* empty */ }
  }

  // Also check all iteration evidence dirs if no iteration specified
  if (iteration === undefined) {
    const evidenceRoot = evidenceDir(goalId)
    if (existsSync(evidenceRoot)) {
      try {
        const subdirs = await readdir(evidenceRoot, { withFileTypes: true })
        for (const subdir of subdirs.filter((d) => d.isDirectory() && d.name.startsWith('iteration-'))) {
          const iterNum = parseInt(subdir.name.replace('iteration-', ''), 10)
          if (!isNaN(iterNum)) {
            const iterItems = await collectEvidence(goalId, iterNum)
            const knownPaths = new Set(items.map((i) => i.path))
            for (const item of iterItems) {
              if (!knownPaths.has(item.path)) items.push(item)
            }
          }
        }
      } catch { /* empty */ }
    }
  }

  return items
}

async function handleGoalCommand(text: string, ctx: ExtensionContext): Promise<string> {
  const trimmed = text.trim()
  const goalMatch = trimmed.match(/^(?:pi\s+)?goal(?:s)?\s+(.+)$/i) ?? trimmed.match(/^\/goal\s+(.+)$/i)

  // ─── Help / no args ───
  if (!goalMatch || /^help$/i.test(goalMatch?.[1] ?? '')) {
    const goals = await listGoals()
    const activeGoal = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    let help = `Goal — persistent objective coordinator with visual evidence

GOALS ARE NOT JUST TEXT CLAIMS. Every goal requires visual proof:
screenshots showing the working result, screen recordings of flows,
and multimodal evaluation that actually looks at the evidence.

Usage:
  goal "<objective>"                  Set a new goal
  goal status                          Show current goal + evidence
  goal pause                           Pause active goal
  goal resume                          Resume paused goal
  goal clear                           Remove current goal
  goal iterate                         Create a coordination brief for the current session
  goal evaluate                        Evaluate handoffs AND visual evidence
  goal screenshot                      Capture screenshot now (to evidence dir)
  goal screenshot --window             Capture specific window
  goal record-start                    Start screen recording
  goal record-stop <pid>               Stop screen recording
  goal evidence                        List all captured evidence
  goal iterations                      Show iteration history
  goal list                             List all goals

Evidence and verification:
  Every completed goal requires at least one screenshot.
  Interactive goals also require a screen recording of the flow working end-to-end.
  Capture screenshots/video of the final product or feature working.
  The current multimodal model, or configured vision model (${DEFAULT_VISION_MODEL}),
  reviews the visual evidence — not just text claims or worker handoffs.
  Screenshots go to: ~/.pi/agent/pi-goals/<id>/evidence/

Goal is a coordinator, not an automatic worker spawner.
Use scouts/planners/reviewers only when they reduce context load; avoid implementation workers unless explicitly requested.
The multimodal evaluator reviews screenshots + recordings and outputs:
  - COMPLETION: percentage
  - GOAL_MET: yes/no/partial
  - VISUAL_NOTES: UX/visual observations
  - BLOCKERS: what prevents completion
  - RECOMMENDATION: iterate/done/blocked
`
    if (activeGoal) {
      const evidence = await collectEvidence(activeGoal.id)
      help += `\n\nActive goal:\n  ${activeGoal.id}\n  "${activeGoal.goal}"\n  Status: ${activeGoal.status}\n  Iteration: ${activeGoal.currentIteration}\n  Delegated runs: ${activeGoal.workerIds.length} recorded\n  Evidence: ${evidence.length} files captured\n  Created: ${activeGoal.createdAt}`
    }
    return help
  }

  const subcommand = goalMatch[1].trim()

  // ─── Status ───
  if (/^status$/i.test(subcommand)) {
    const goals = await listGoals()
    const activeGoal = goals.find((g) => g.status !== 'done')
    if (!activeGoal) return 'No active goal. Set one with: goal "<objective>"'
    const iterations = await readIterations(activeGoal.id)
    const elapsed = Date.now() - new Date(activeGoal.createdAt).getTime()
    const completedIterations = iterations.filter((i) => i.completedAt)
    const evidence = await collectEvidence(activeGoal.id)
    const screenshots = evidence.filter((e) => e.type === 'screenshot')
    const recordings = evidence.filter((e) => e.type === 'recording' || e.type === 'screencast')

    return `Goal ${activeGoal.id}
Objective: ${activeGoal.goal}
Verification: ${activeGoal.verification}
Constraints: ${activeGoal.constraints || 'none specified'}
Status: ${activeGoal.status}
Iteration: ${activeGoal.currentIteration} (${completedIterations.length}/${iterations.length} subtasks completed)
Delegated runs recorded: ${activeGoal.workerIds.length}
Elapsed: ${formatDuration(elapsed)}
Created: ${activeGoal.createdAt}
Updated: ${activeGoal.updatedAt}

Visual Evidence:
  Required: ${evidenceRequirementText(`${activeGoal.goal} ${activeGoal.verification}`)}
  Screenshots: ${screenshots.length}
  Recordings: ${recordings.length}
  Total files: ${evidence.length}
${screenshots.length > 0 ? screenshots.slice(-5).map((s) => `    📸 ${s.label}: ${s.path}`).join('\n') : '  (none captured yet — run "goal screenshot" after there is something visual to verify)'}
${recordings.length > 0 ? recordings.map((r) => `    🎬 ${r.label}: ${r.path}`).join('\n') : ''}

${completedIterations.length > 0 ? 'Latest assessments:\n' + completedIterations.slice(-3).map((i) => `  [${i.iteration}] ${i.role} → ${i.assessment ?? 'no assessment'}${i.visualNotes ? '\n    Visual notes: ' + i.visualNotes.slice(0, 150) : ''}`).join('\n') : 'No iterations completed yet.'}`
  }

  // ─── Pause ───
  if (/^pause$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal to pause.'
    active.status = 'paused'
    await writeGoal(active)
    return `Goal ${active.id} paused.\nUse "goal resume" to continue.`
  }

  // ─── Resume ───
  if (/^resume$/i.test(subcommand)) {
    const goals = await listGoals()
    const paused = goals.find((g) => g.status === 'paused')
    if (!paused) return 'No paused goal to resume.'
    paused.status = 'executing'
    await writeGoal(paused)
    return `Goal ${paused.id} resumed.\nReady to iterate. Use "goal iterate" to plan next iteration.`
  }

  // ─── Clear ───
  if (/^clear$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done')
    if (!active) return 'No active goal to clear.'
    active.status = 'done'
    await writeGoal(active)
    return `Goal ${active.id} cleared.`
  }

  // ─── List ───
  if (/^list$/i.test(subcommand)) {
    const goals = await listGoals()
    if (goals.length === 0) return 'No goals yet.'
    return (await Promise.all(goals.map(async (g) => {
      const evidence = await collectEvidence(g.id)
      return `${g.status.padEnd(12)} ${g.id}  ${g.currentIteration} iters  📸${evidence.filter((e) => e.type === 'screenshot').length} 🎬${evidence.filter((e) => e.type === 'recording' || e.type === 'screencast').length}  "${g.goal.slice(0, 60)}${g.goal.length > 60 ? '...' : ''}"`
    }))).join('\n')
  }

  // ─── Iterations ───
  if (/^iterations?$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done') ?? goals[goals.length - 1]
    if (!active) return 'No goal found.'
    const iterations = await readIterations(active.id)
    if (iterations.length === 0) return `No iterations for goal ${active.id} yet.`
    return `Iterations for goal ${active.id}:\n` + iterations.map((i) =>
      `[${i.iteration}] ${i.role} (${i.workerId})\n  Task: ${i.workerTask.slice(0, 120)}\n  Status: ${i.completedAt ? 'completed' : 'pending'}\n  Evidence: ${i.evidence.length} files${i.evidence.length > 0 ? ` (${i.evidence.filter((e) => e.type === 'screenshot').length} screenshots, ${i.evidence.filter((e) => e.type === 'recording' || e.type === 'screencast').length} recordings)` : ''}\n  ${i.assessment ? `Assessment: ${i.assessment.slice(0, 200)}` : 'No assessment'}\n  ${i.goalMet !== undefined ? `Goal met: ${i.goalMet}` : ''}\n  ${i.visualNotes ? `Visual notes: ${i.visualNotes.slice(0, 200)}` : ''}`
    ).join('\n')
  }

  // ─── Evidence ───
  if (/^evidence$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done') ?? goals[0]
    if (!active) return 'No goal found.'
    const evidence = await collectEvidence(active.id)
    if (evidence.length === 0) return `No visual evidence for goal ${active.id} yet.\n\nCapture evidence when the final product/feature is visible:\n  goal screenshot\n  goal screenshot --window\n  goal record-start`
    return `Visual evidence for goal ${active.id}:\n\n` + evidence.map((e) =>
      `${e.type === 'screenshot' ? '📸' : e.type === 'recording' ? '🎬' : '📄'} ${e.label}\n  Path: ${e.path}\n  Captured: ${e.capturedAt}${e.description ? `\n  ${e.description}` : ''}`
    ).join('\n\n')
  }

  // ─── Screenshot ───
  if (/^screenshot(?:\s+--window)?$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal. Screenshots need an active goal to attach to.'
    const evDir = evidenceDir(active.id, active.currentIteration || 1)
    await ensureDir(evDir)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `screenshot-manual-${timestamp}.png`
    const outputPath = path.join(evDir, filename)
    const useWindow = /--window/.test(subcommand)
    const success = useWindow ? await captureWindowScreenshot(outputPath) : await captureScreenshot(outputPath)
    if (success && existsSync(outputPath)) {
      await execCmd('osascript', ['-e', `display notification "Screenshot saved for goal ${active.id}" with title "Goal"`], {}).catch(() => {})
      return `📸 Screenshot captured!\n\nPath: ${outputPath}\nGoal: ${active.id}\nIteration: ${active.currentIteration || 1}\n\nView with: open "${outputPath}"`
    }
    return `Failed to capture screenshot. On macOS, ensure:\n- Screen recording permission is granted to Terminal/Pi\n- Use --window flag to select a specific window\n- Or capture manually and save to: ${evDir}/`
  }

  // ─── Record start ───
  if (/^record-start$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal. Recording needs an active goal to attach to.'
    const evDir = evidenceDir(active.id, active.currentIteration || 1)
    await ensureDir(evDir)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const outputPath = path.join(evDir, `recording-${timestamp}.mp4`)
    const pid = await startScreenRecording(outputPath)
    if (pid) {
      return `🎬 Recording started (PID: ${pid})!\n\nOutput: ${outputPath}\nGoal: ${active.id}\n\nStop with: goal record-stop ${pid}\n\nNote: Requires ffmpeg and screen recording permission for Terminal.`
    }
    return `Could not start recording (ffmpeg not found or permission denied).\n\nInstall ffmpeg: brew install ffmpeg\nGrant screen recording permission: System Settings → Privacy & Security → Screen Recording\n\nAlternative: Use macOS Screenshot toolbar (Cmd+Shift+5) to record screen, then save the file to:\n${evDir}/`
  }

  // ─── Record stop ───
  if (/^record-stop\s+(\S+)/i.test(subcommand)) {
    const pidMatch = subcommand.match(/^record-stop\s+(\S+)$/i)
    if (!pidMatch) return 'Usage: goal record-stop <pid>'
    const pid = pidMatch[1]
    await stopScreenRecording(pid)
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    await execCmd('osascript', ['-e', `display notification "Recording stopped for goal ${active?.id ?? 'unknown'}" with title "Goal"`], {}).catch(() => {})
    return `🎬 Recording stopped (PID: ${pid}).\n\nAllow a few seconds for ffmpeg to finalize the file.\nCheck evidence with: goal evidence`
  }

  // ─── Iterate ───
  if (/^iterate$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal. Set one with: goal "<objective>"'

    const roles = suggestRoles(active.goal)
    const iteration = active.currentIteration + 1
    const previousIterations = await readIterations(active.id)
    const evDir = evidenceDir(active.id, iteration)
    await ensureDir(evDir)

    // Build iteration prompt with visual evidence instructions
    const previousHandoffs = previousIterations
      .filter((i) => i.handoffPath && existsSync(i.handoffPath))
      .map((i) => `- [${i.iteration}] ${i.role}: ${i.assessment ?? 'see handoff'}`)
      .join('\n')

    const previousEvidence = previousIterations
      .flatMap((i) => i.evidence)
      .filter((e) => existsSync(e.path))

    const evidenceList = previousEvidence.length > 0
      ? `\nPrevious visual evidence:\n${previousEvidence.map((e) => `- ${e.type}: ${e.path}`).join('\n')}`
      : ''

    const brief = `Iteration ${iteration} coordination brief for goal: "${active.goal}"

Verification: ${active.verification}
${active.constraints ? `Constraints: ${active.constraints}` : ''}

${previousHandoffs ? `Previous delegated results:\n${previousHandoffs}` : 'First iteration — no prior delegated work recorded.'}
${evidenceList}

Recommended operating mode:
- Keep ownership in the current Pi session.
- Use local tools directly first: read, bash, edit/write, web/github/video tools as needed.
- Pull in a scout/researcher/planner/reviewer worker only when it reduces context load or risk.
- Do NOT use implementation workers by default; they can blow the context window and lose ownership.
- If delegation is useful, delegate narrow read-only tasks first: map files, research docs, critique plan, review diff.
- Capture visual evidence of the final product/feature, not the worker terminal.

${evidenceInstructions(active.id, iteration)}

Suggested optional helper roles: ${roles.length > 0 ? roles.join(', ') : 'none by default — use current-session tools first'}.

Current-session checklist:
1. Decide the smallest next action.
2. Inspect only relevant files/sources.
3. Implement directly in this session if implementation is needed.
4. Validate with focused tests/checks.
5. Capture screenshots/recording of the result.
6. Run goal evaluate / evaluate-visual.`

    active.currentIteration = iteration
    await writeGoal(active)

    return `Iteration ${iteration} for goal ${active.id}

Suggested optional helper roles: ${roles.length > 0 ? roles.join(', ') : 'none by default'}
Evidence dir: ${evDir}

${brief}

If you choose to delegate, prefer narrow read-only helpers, for example:
${roles.length > 0 ? roles.map((role) => `  worker ${role} "Read-only helper for goal ${active.id}: ${active.goal}. Return concise findings only; do not implement."`).join('\n') : '  (no worker suggested for this goal yet)'}

Otherwise continue in the current session and use goal evaluate / evaluate-visual when evidence exists.`
  }

  // ─── Evaluate ───
  if (/^evaluate$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal.'

    const iterations = await readIterations(active.id)
    const completedIterations = iterations.filter((i) => i.completedAt && i.handoffPath && existsSync(i.handoffPath))
    const allEvidence = await collectEvidence(active.id)

    if (completedIterations.length === 0 && allEvidence.length === 0) {
      return `No delegated handoffs or visual evidence for goal ${active.id}.\nContinue in the current session, then capture evidence with:\n  goal screenshot\n  goal screenshot --window\n  goal record-start`
    }

    // Read latest handoffs
    const handoffSummaries: string[] = []
    for (const iter of completedIterations.slice(-5)) {
      try {
        const handoff = await readFile(iter.handoffPath!, 'utf8')
        const lines = handoff.split('\n').slice(0, 30).join('\n')
        handoffSummaries.push(`[${iter.iteration}] ${iter.role}:\n${lines}`)
      } catch {
        handoffSummaries.push(`[${iter.iteration}] ${iter.role}: (could not read handoff)`)
      }
    }

    // Gather evidence paths for the evaluator
    const evidencePaths = allEvidence.map((e) => e.path)
    const screenshots = allEvidence.filter((e) => e.type === 'screenshot')
    const recordings = allEvidence.filter((e) => e.type === 'recording' || e.type === 'screencast')

    // Build evaluation prompt
    const evalPrompt = visualEvaluationPrompt(active, evidencePaths)

    // Check if any iteration marked goal as met
    const metIteration = completedIterations.find((i) => i.goalMet === true)

    if (metIteration) {
      const blockers = evidenceBlockers(active, allEvidence)
      if (blockers.length > 0) {
        active.status = 'evaluating'
        await writeGoal(active)
        return `Goal cannot be marked done yet — required visual evidence is missing.

Goal: ${active.goal}
Missing evidence:
${blockers.map((b) => `- ${b}`).join('\n')}

Capture evidence with:
  goal screenshot
  goal screenshot --window
${requiresRecording(`${active.goal} ${active.verification}`) ? '  goal record-start\n  goal record-stop <pid>' : ''}

Then run goal evaluate again.`
      }

      active.status = 'done'
      await writeGoal(active)
      await execCmd('osascript', ['-e', `display notification "✅ Goal achieved: ${active.goal.slice(0, 80)}" with title "Goal"`], {}).catch(() => {})

      return `✅ Goal achieved with visual proof!

Goal: ${active.goal}
Iterations: ${active.currentIteration}
Delegated runs: ${active.workerIds.length}

Visual Evidence:
  ${screenshots.length} screenshots, ${recordings.length} recordings

${screenshots.slice(-5).map((s) => `  📸 ${s.label}: ${s.path}`).join('\n')}
${recordings.slice(-3).map((r) => `  🎬 ${r.label}: ${r.path}`).join('\n')}

Text handoff marking goal as met:
${handoffSummaries.join('\n\n')}

To do a full multimodal evaluation, run:
  goal evaluate-visual

Use "goal clear" to close the completed goal.`
    }

    // Check for blocked
    const blockedIteration = completedIterations.find((i) => i.goalMet === false && i.assessment?.toLowerCase().includes('blocked'))
    if (blockedIteration) {
      active.status = 'blocked'
      await writeGoal(active)
      await execCmd('osascript', ['-e', `display notification "⚠️ Goal blocked: ${active.goal.slice(0, 70)}" with title "Goal"`], {}).catch(() => {})
      return `⚠️ Goal blocked!

Goal: ${active.goal}
Blocked at iteration ${blockedIteration.iteration} (${blockedIteration.role}):
${blockedIteration.assessment}

Suggestions:
- Address the blocker and run "goal iterate"
- Run "goal pause" to pause
- Run "goal clear" to abandon`
    }

    // Not met yet — report progress with available evidence
    active.status = 'evaluating'
    await writeGoal(active)

    const evidenceReport = screenshots.length > 0
      ? `\n\nVisual evidence captured:\n${screenshots.map((s) => `  📸 ${s.label}: ${s.path}`).join('\n')}\n${recordings.length > 0 ? recordings.map((r) => `  🎬 ${r.label}: ${r.path}`).join('\n') : ''}\n\nTo evaluate with multimodal vision, run:\n  goal evaluate-visual`
      : '\n\n⚠️  No screenshots or recordings captured yet!\nCapture evidence with:\n  goal screenshot\n  goal screenshot --window\n  goal record-start'

    return `Goal not yet met.

Goal: ${active.goal}
Verification: ${active.verification}
Iterations completed: ${completedIterations.length}
Delegated runs recorded: ${active.workerIds.length}

Latest handoffs:
${handoffSummaries.join('\n\n')}
${evidenceReport}

Next steps:
- Continue in the current session or delegate a narrow read-only helper if needed
- Run "goal screenshot" / "goal record-start" when the product/feature is visible
- Run "goal evaluate-visual" for multimodal evaluation of screenshots
- Run "goal iterate" for the next coordination brief`
  }

  // ─── Evaluate-visual ───
  if (/^evaluate-visual$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal.'

    const allEvidence = await collectEvidence(active.id)
    const evidencePaths = allEvidence.map((e) => e.path).filter((p) => existsSync(p))

    if (evidencePaths.length === 0) {
      return `No visual evidence to evaluate for goal ${active.id}.\n\nCapture screenshots first:\n  goal screenshot\n  goal screenshot --window\n\nGoal evaluates the final product/feature, not worker terminals.`
    }

    // Generate the multimodal evaluation instructions
    const evalPrompt = visualEvaluationPrompt(active, evidencePaths)

    return `Multimodal Evaluation Required

The goal coordinator cannot evaluate visual evidence directly from the command line.
Use a vision-capable model (default: ${active.visionModel}) to evaluate.

## Evaluation Prompt

${evalPrompt}

## Evidence Files to Review

${evidencePaths.map((p) => `- ${p}`).join('\n')}

## How to Evaluate

Option 1 — Ask your current Pi session to review the evidence:
  "Look at these screenshots and evaluate whether the goal is achieved:
   Goal: ${active.goal}
   Verification: ${active.verification}
   Evidence: ${evidencePaths.join(', ')}"

Option 2 — If you explicitly want a separate reviewer, spawn a narrow read-only reviewer:
  worker reviewer --model ${active.visionModel} "Read-only visual review for goal ${active.id}: ${active.goal}. Review screenshots in ${evidenceDir(active.id)} and return concise GOAL_MET/COMPLETION/VISUAL_NOTES. Do not implement."

Option 3 — View the evidence yourself:
${evidencePaths.slice(0, 10).map((p) => `  open "${p}"`).join('\n')}

After evaluation, update the goal:
  goal note "VISUAL_NOTES: <your observations>"
  goal note "COMPLETION: <percentage>"
  goal note "GOAL_MET: <yes|no|partial>"`
  }

  // ─── Note ───
  if (/^note\s+(.+)$/i.test(subcommand)) {
    const noteMatch = subcommand.match(/^note\s+(.+)$/i)
    if (!noteMatch) return 'Usage: goal note "<note text>"'
    const noteContent = noteMatch[1]
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal.'

    const notePath = path.join(ROOT, active.id, 'notes.md')
    const timestamp = new Date().toISOString()
    const noteEntry = `\n## ${timestamp}\n\n${noteContent}\n`
    await writeFile(notePath, existsSync(notePath) ? noteEntry : `# Goal Notes — ${active.id}\n${noteEntry}`, 'utf8')

    // Parse structured notes
    const completeByPercent = /^COMPLETION:/i.test(noteContent) && parseInt(noteContent.match(/COMPLETION:\s*(\d+)/)?.[1] ?? '0') >= 100
    const completeByGoalMet = /^GOAL_MET:\s*yes/i.test(noteContent)
    if (completeByPercent || completeByGoalMet) {
      const evidence = await collectEvidence(active.id)
      const blockers = evidenceBlockers(active, evidence)
      if (blockers.length > 0) {
        active.status = 'evaluating'
        await writeGoal(active)
        return `Note recorded, but goal cannot be marked done yet — required visual evidence is missing.\n\nMissing evidence:\n${blockers.map((b) => `- ${b}`).join('\n')}\n\nCapture evidence with:\n  goal screenshot\n  goal screenshot --window\n${requiresRecording(`${active.goal} ${active.verification}`) ? '  goal record-start\n  goal record-stop <pid>\n' : ''}\nThen add GOAL_MET: yes or COMPLETION: 100 again.\n\n${noteContent}`
      }
      active.status = 'done'
      await writeGoal(active)
      await execCmd('osascript', ['-e', `display notification "Goal achieved: ${active.goal.slice(0, 80)}" with title "Goal"`], {}).catch(() => {})
      return `Note recorded. Required visual evidence present → Goal marked as done! 🎉\n\n${noteContent}`
    }
    if (/^GOAL_MET:\s*blocked/i.test(noteContent)) {
      active.status = 'blocked'
      await writeGoal(active)
      return `Note recorded. Goal status → blocked ⚠️\n\n${noteContent}`
    }

    return `Note recorded for goal ${active.id}.\n\n${noteContent}`
  }

  // ─── Set a new goal ───
  const goalText = trimmed.replace(/^(?:pi\s+)?goal(?:s)?\s+/i, '').replace(/^\/goal\s+/i, '')

  let verification = ''
  let constraints = ''
  let maxIterations = 10
  let model = DEFAULT_COORDINATOR_MODEL
  let visionModel = DEFAULT_VISION_MODEL

  const vMatch = goalText.match(/--verify\s+"([^"]+)"/)
  if (vMatch) { verification = vMatch[1] }
  const cMatch = goalText.match(/--constraints?\s+"([^"]+)"/)
  if (cMatch) { constraints = cMatch[1] }
  const mMatch = goalText.match(/--max-iterations?\s+(\d+)/)
  if (mMatch) { maxIterations = parseInt(mMatch[1]) }
  const mmMatch = goalText.match(/--model\s+(\S+)/)
  if (mmMatch) { model = mmMatch[1] }
  const vmMatch = goalText.match(/--vision-model\s+(\S+)/)
  if (vmMatch) { visionModel = vmMatch[1] }

  let cleanGoal = goalText
    .replace(/--verify\s+"[^"]+"/, '')
    .replace(/--constraints?\s+"[^"]+"/, '')
    .replace(/--max-iterations?\s+\d+/, '')
    .replace(/--model\s+\S+/, '')
    .replace(/--vision-model\s+\S+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if ((cleanGoal.startsWith('"') && cleanGoal.endsWith('"')) || (cleanGoal.startsWith("'") && cleanGoal.endsWith("'"))) {
    cleanGoal = cleanGoal.slice(1, -1)
  }

  if (!cleanGoal) return 'Please provide a goal objective. Example: goal "Fix all vault policy conflicts"'

  if (!verification) verification = inferVerification(cleanGoal)

  const id = shortId()
  const goal: GoalRecord = {
    id,
    goal: cleanGoal,
    verification,
    constraints,
    status: 'planning',
    model,
    visionModel,
    maxIterations,
    currentIteration: 0,
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  await ensureDir(path.join(ROOT, id))
  await ensureDir(evidenceDir(id))
  await writeGoal(goal)
  await writeIterations(id, [])

  // Write goal markdown with evidence emphasis
  await writeFile(path.join(ROOT, id, 'goal.md'), `# Goal

## Objective

${cleanGoal}

## Verification

${verification}

${constraints ? `## Constraints\n\n${constraints}` : ''}

## Visual Evidence Required

This goal requires **visual proof of completion**, not just text claims.

Required evidence:

${evidenceRequirementText(cleanGoal)}

Capture:
- **Screenshots** of the working result at every key state
- **Screen recordings** of interactive flows when the goal is interactive (forms, transitions, multi-step processes)
- **Evidence manifest** listing all captured files with labels

The evaluation model (${visionModel}) will use multimodal vision to:
- Confirm the feature actually works as intended
- Note visual/UX issues (layout, contrast, responsiveness, accessibility)
- Identify edge cases visible in the evidence
- Determine if patterns are consistent across states

## Status

- Status: planning
- Max iterations: ${maxIterations}
- Coordinator model: ${model} (text evaluation)
- Vision model: ${visionModel} (multimodal evaluation)
- Created: ${goal.createdAt}

## Evidence

${evidenceDir(id)}/

## Iterations

(No iterations yet. Run "goal iterate" to create the first coordination brief.)

## Notes

(Use "goal note <text>" to add evaluation notes.)
`, 'utf8')

  // Write evaluation prompt
  await writeFile(path.join(ROOT, id, 'eval-prompt.md'), visualEvaluationPrompt(goal, []), 'utf8')

  const roles = suggestRoles(cleanGoal)

  return `Goal created: ${id}

Objective: ${cleanGoal}
Evidence dir: ${evidenceDir(id)}
Optional helper roles: ${roles.length > 0 ? roles.join(', ') : 'none by default'}

Goal is now tracking this objective. It will not auto-spawn workers.
Use current-session tools first. Run "goal iterate" for a coordination brief, and delegate only narrow scout/research/planner/reviewer work when useful.`
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('goal', {
    description: 'Set and manage persistent goals with visual evidence verification',
    handler: async (args, ctx) => {
      try {
        const result = await handleGoalCommand(`goal ${args}`, ctx)
        ctx.ui.notify(result, 'info')
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.on('input', async (event, ctx) => {
    if (!/^(?:pi\s+)?goal(?:s)?\b/i.test(event.text.trim()) && !/^\/goal\b/i.test(event.text.trim())) return { action: 'continue' }
    try {
      const result = await handleGoalCommand(event.text, ctx)
      ctx.ui.notify(result, 'info')
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    }
    return { action: 'handled' }
  })

  pi.registerTool({
    name: 'goal',
    label: 'Goal',
    description: 'Set and manage persistent goals with visual evidence verification. Goals require screenshot/recording proof that the result actually works, not just text claims. A multimodal vision model evaluates the visual evidence to confirm completion.',
    promptSnippet: 'Set and manage persistent goals with visual evidence verification',
    promptGuidelines: [
      'Use goal when the user wants to achieve a multi-step objective with verifiable results.',
      'Goal is a lightweight coordinator/evaluator, not an automatic worker spawner.',
      'Use current-session tools first. Pull in scout/researcher/planner/reviewer workers only when they reduce context load or risk.',
      'Do not use implementation workers by default; only spawn worker role if the user explicitly requests delegated implementation.',
      'Keep goal creation responses concise; do not dump long next-step instructions unless asked.',
      'Every completed goal requires at least one screenshot showing the working result.',
      'Interactive goals require a screen recording of the flow working end-to-end before they can be marked done.',
      'The evaluation model uses multimodal vision to confirm: does it actually work, not just does the code exist.',
      'Use goal screenshot to manually capture evidence at any time.',
      'Use goal evaluate-visual to trigger a vision model review of captured evidence.',
    ],
    parameters: Type.Object({
      action: StringEnum(['set', 'status', 'pause', 'resume', 'clear', 'iterate', 'evaluate', 'evaluate-visual', 'screenshot', 'record-start', 'record-stop', 'evidence', 'list', 'iterations', 'note'] as const),
      goal: Type.Optional(Type.String({ description: 'The objective to achieve' })),
      verification: Type.Optional(Type.String({ description: 'How to verify the goal is met (should include visual proof requirement)' })),
      constraints: Type.Optional(Type.String({ description: 'What must not regress' })),
      maxIterations: Type.Optional(Type.Number({ description: 'Maximum iterations (default 10)' })),
      model: Type.Optional(Type.String({ description: 'Coordinator model for text evaluation (default deepseek-v4-flash)' })),
      visionModel: Type.Optional(Type.String({ description: 'Vision model for multimodal evaluation (default claude-sonnet-4)' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === 'list') {
        return { content: [{ type: 'text', text: await (async () => { const goals = await listGoals(); return goals.length === 0 ? 'No goals yet.' : (await Promise.all(goals.map(async (g) => { const evidence = await collectEvidence(g.id); return `${g.status.padEnd(12)} ${g.id}  ${g.currentIteration} iters  📸${evidence.filter((e) => e.type === 'screenshot').length} 🎬${evidence.filter((e) => e.type === 'recording' || e.type === 'screencast').length}  "${g.goal.slice(0, 60)}"`; }))).join('\n'); })() }] }
      }

      if (params.action === 'set') {
        if (!params.goal) throw new Error('set requires goal text')
        const goalText = `${params.goal}${params.verification ? ` --verify "${params.verification}"` : ''}${params.constraints ? ` --constraints "${params.constraints}"` : ''}${params.maxIterations ? ` --max-iterations ${params.maxIterations}` : ''}${params.model ? ` --model ${params.model}` : ''}${params.visionModel ? ` --vision-model ${params.visionModel}` : ''}`
        const result = await handleGoalCommand(`goal ${goalText}`, ctx)
        return { content: [{ type: 'text', text: result }] }
      }

      if (params.action === 'screenshot') {
        const result = await handleGoalCommand('goal screenshot', ctx)
        return { content: [{ type: 'text', text: result }] }
      }

      if (params.action === 'evidence') {
        const result = await handleGoalCommand('goal evidence', ctx)
        return { content: [{ type: 'text', text: result }] }
      }

      // All other actions delegate
      const commandText = `goal ${params.action}`
      const result = await handleGoalCommand(commandText, ctx)
      return { content: [{ type: 'text', text: result }] }
    },
  })

  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus('goal', 'goal ready')
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus('goal', undefined)
  })
}