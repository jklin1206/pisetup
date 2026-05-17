import { existsSync, mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

const ROOT = path.join(os.homedir(), '.pi', 'agent', 'pi-goals')
const WORKERS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'pi-workers')

type GoalRole = 'scout' | 'researcher' | 'planner' | 'reviewer' | 'worker'
type GoalStatus = 'planning' | 'executing' | 'evaluating' | 'done' | 'blocked' | 'paused'

type GoalRecord = {
  id: string
  goal: string
  verification: string
  constraints: string
  status: GoalStatus
  model: string
  maxIterations: number
  currentIteration: number
  workerIds: string[]
 createdAt: string
  updatedAt: string
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
}

const DEFAULT_COORDINATOR_MODEL = 'opencode-go/deepseek-v4-flash'

const ROLE_SUGGESTIONS: Record<string, GoalRole[]> = {
  audit: ['scout', 'reviewer'],
  research: ['researcher', 'scout'],
  plan: ['scout', 'planner'],
  implement: ['scout', 'planner', 'worker'],
  review: ['reviewer'],
  fix: ['scout', 'planner', 'worker', 'reviewer'],
  cleanup: ['scout', 'worker', 'reviewer'],
  organize: ['scout', 'worker', 'reviewer'],
  migrate: ['scout', 'planner', 'worker', 'reviewer'],
  explore: ['scout'],
  catalog: ['researcher', 'worker'],
  default: ['scout', 'planner', 'worker', 'reviewer'],
}

function shortId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function execCmd(command: string, args: string[], opts: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error: Error) => resolve({ stdout, stderr: error.message, code: 127 }))
    child.on('close', (code: number | null) => resolve({ stdout, stderr, code }))
  })
}

async function ensureRoot() {
  await mkdir(ROOT, { recursive: true })
}

async function readGoal(id: string): Promise<GoalRecord | null> {
  try {
    return JSON.parse(await readFile(path.join(ROOT, id, 'goal.json'), 'utf8')) as GoalRecord
  } catch {
    return null
  }
}

async function writeGoal(goal: GoalRecord) {
  await mkdir(path.join(ROOT, goal.id), { recursive: true })
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
  if (/test|pass|green|failing/i.test(goal)) return 'All tests pass with no regressions.'
  if (/fix|bug|error|broken/i.test(goal)) return 'The reported issue is resolved and verified.'
  if (/clean|organize|audit|conflict/i.test(goal)) return 'All identified conflicts are resolved and verified by review.'
  if (/catalog|populate|document/i.test(goal)) return 'All target items are cataloged and cross-linked.'
  if (/implement|build|create/i.test(goal)) return 'Implementation matches the spec and passes review.'
  if (/research|investigate|find/i.test(goal)) return 'Research findings are documented with sources and gaps identified.'
  return 'The objective described in the goal is complete and verifiable.'
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

async function handleGoalCommand(text: string, ctx: ExtensionContext): Promise<string> {
  const trimmed = text.trim()
  // Match "pi goal ..." or "/goal ..."
  const goalMatch = trimmed.match(/^(?:pi\s+)?goal\s+(.+)$/i) ?? trimmed.match(/^\/goal\s+(.+)$/i)

  // No args or "help" — show status
  if (!goalMatch || /^help$/i.test(goalMatch?.[1] ?? '')) {
    const goals = await listGoals()
    const activeGoal = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    let help = `Pi Goal — persistent objective coordinator for Pi Workers

Usage:
  pi goal "<objective>"         Set a new goal
  pi goal status                 Show current goal status
  pi goal pause                  Pause active goal
  pi goal resume                 Resume paused goal
  pi goal clear                  Remove current goal
  pi goal iterate                Plan next iteration and spawn workers
  pi goal evaluate              Evaluate current handoffs against goal
  pi goal iterations             Show iteration history
  pi goal list                   List all goals

Goal format:
  pi goal "Fix all vault policy conflicts and verify by review"

The goal persists across iterations. Each iteration spawns role-appropriate
Pi Workers, collects handoffs, and evaluates progress.

Roles are inferred from the goal text:
  audit/review → scout + reviewer
  research → researcher + scout
  plan → scout + planner
  implement/fix → scout + planner + worker
  cleanup/organize → scout + worker + reviewer

Coordinator model: ${DEFAULT_COORDINATOR_MODEL} (cheap, fast evaluation)
Worker models: role-defaults from Pi Workers config
`
    if (activeGoal) {
      help += `\n\nActive goal:\n  ${activeGoal.id}\n  "${activeGoal.goal}"\n  Status: ${activeGoal.status}\n  Iteration: ${activeGoal.currentIteration}\n  Workers: ${activeGoal.workerIds.length} spawned\n  Created: ${activeGoal.createdAt}`
    }
    return help
  }

  const subcommand = goalMatch[1].trim()

  // Status
  if (/^status$/i.test(subcommand)) {
    const goals = await listGoals()
    const activeGoal = goals.find((g) => g.status !== 'done')
    if (!activeGoal) return 'No active goal. Set one with: pi goal "<objective>"'
    const iterations = await readIterations(activeGoal.id)
    const elapsed = Date.now() - new Date(activeGoal.createdAt).getTime()
    const completedIterations = iterations.filter((i) => i.completedAt)
    return `Goal ${activeGoal.id}
Objective: ${activeGoal.goal}
Verification: ${activeGoal.verification}
Constraints: ${activeGoal.constraints || 'none specified'}
Status: ${activeGoal.status}
Iteration: ${activeGoal.currentIteration} (${completedIterations.length}/${iterations.length} subtasks completed)
Workers spawned: ${activeGoal.workerIds.length}
Elapsed: ${formatDuration(elapsed)}
Created: ${activeGoal.createdAt}
Updated: ${activeGoal.updatedAt}

${completedIterations.length > 0 ? 'Latest assessments:\n' + completedIterations.slice(-3).map((i) => `  [${i.iteration}] ${i.role} → ${i.assessment ?? 'no assessment'}`).join('\n') : 'No iterations completed yet.'}`
  }

  // Pause
  if (/^pause$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal to pause.'
    active.status = 'paused'
    await writeGoal(active)
    return `Goal ${active.id} paused.\nUse "pi goal resume" to continue.`
  }

  // Resume
  if (/^resume$/i.test(subcommand)) {
    const goals = await listGoals()
    const paused = goals.find((g) => g.status === 'paused')
    if (!paused) return 'No paused goal to resume.'
    paused.status = 'executing'
    await writeGoal(paused)
    return `Goal ${paused.id} resumed.\nReady to iterate. Use "pi goal iterate" to plan next iteration.`
  }

  // Clear
  if (/^clear$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done')
    if (!active) return 'No active goal to clear.'
    active.status = 'done'
    await writeGoal(active)
    return `Goal ${active.id} cleared.`
  }

  // List
  if (/^list$/i.test(subcommand)) {
    const goals = await listGoals()
    if (goals.length === 0) return 'No goals yet.'
    return goals.map((g) =>
      `${g.status.padEnd(12)} ${g.id}  ${g.currentIteration} iterations  "${g.goal.slice(0, 80)}${g.goal.length > 80 ? '...' : ''}"`
    ).join('\n')
  }

  // Iterations
  if (/^iterations?$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done') ?? goals[goals.length - 1]
    if (!active) return 'No goal found.'
    const iterations = await readIterations(active.id)
    if (iterations.length === 0) return `No iterations for goal ${active.id} yet.`
    return `Iterations for goal ${active.id}:\n` + iterations.map((i) =>
      `[${i.iteration}] ${i.role} (${i.workerId})\n  Task: ${i.workerTask.slice(0, 120)}\n  Status: ${i.completedAt ? 'completed' : 'pending'}\n  ${i.assessment ? `Assessment: ${i.assessment.slice(0, 200)}` : 'No assessment'}\n  ${i.goalMet !== undefined ? `Goal met: ${i.goalMet}` : ''}`
    ).join('\n')
  }

  // Iterate — plan and suggest next workers
  if (/^iterate$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal. Set one with: pi goal "<objective>"'

    const roles = suggestRoles(active.goal)
    const iteration = active.currentIteration + 1
    const previousIterations = await readIterations(active.id)

    // Build iteration prompt based on previous handoffs
    const previousHandoffs = previousIterations
      .filter((i) => i.handoffPath && existsSync(i.handoffPath))
      .map((i) => `- [${i.iteration}] ${i.role}: ${i.assessment ?? 'see handoff'}`)
      .join('\n')

    const task = `Iteration ${iteration} for goal: "${active.goal}"

Verification: ${active.verification}
${active.constraints ? `Constraints: ${active.constraints}` : ''}

${previousHandoffs ? `Previous iteration results:\n${previousHandoffs}` : 'First iteration — no prior work done.'}

Evaluate progress toward the goal. Read this goal's handoffs from previous iterations if they exist. Then perform your role: ${roles.join(', ')}.

Write your handoff to the run's handoff.md including:
1. What you found/did
2. Whether the goal is met (with evidence)
3. What remains to be done
4. Suggested next iteration roles and tasks`

    active.currentIteration = iteration
    await writeGoal(active)

    return `Iteration ${iteration} for goal ${active.id}

Suggested roles: ${roles.join(', ')}
Task template ready.

Spawn workers with:
${roles.map((role) => `  pi worker ${role} --model ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : '(default)'} "${task.replace(/"/g, '\\"').slice(0, 200)}..."`).join('\n')}

Or use: pi goal evaluate (after workers complete)`
  }

  // Evaluate — read handoffs and assess goal progress
  if (/^evaluate$/i.test(subcommand)) {
    const goals = await listGoals()
    const active = goals.find((g) => g.status !== 'done' && g.status !== 'paused')
    if (!active) return 'No active goal.'

    const iterations = await readIterations(active.id)
    const completedIterations = iterations.filter((i) => i.completedAt && i.handoffPath && existsSync(i.handoffPath))

    if (completedIterations.length === 0) return `No completed iterations yet for goal ${active.id}.\nSpawn workers first, then evaluate after handoffs arrive.`

    // Read latest handoffs
    const handoffSummaries: string[] = []
    for (const iter of completedIterations.slice(-5)) {
      try {
        const handoff = await readFile(iter.handoffPath!, 'utf8')
        const lines = handoff.split('\n').slice(0, 20).join('\n')
        handoffSummaries.push(`[${iter.iteration}] ${iter.role}:\n${lines}`)
      } catch {
        handoffSummaries.push(`[${iter.iteration}] ${iter.role}: (could not read handoff)`)
      }
    }

    // Check if any iteration marked goal as met
    const metIteration = completedIterations.find((i) => i.goalMet === true)

    if (metIteration) {
      active.status = 'done'
      await writeGoal(active)
      await execCmd('osascript', ['-e', `display notification "Goal achieved: ${active.goal.slice(0, 100)}" with title "Pi Goal"`], {}).catch(() => {})
      return `✅ Goal achieved!

Goal: ${active.goal}
Iterations: ${active.currentIteration}
Workers: ${active.workerIds.length}

Latest handoff marking goal as met:
${handoffSummaries.join('\n\n')}

Use "pi goal clear" to remove the completed goal.`
    }

    // Assess progress
    const blockedIteration = completedIterations.find((i) => i.goalMet === false && i.assessment?.toLowerCase().includes('blocked'))

    if (blockedIteration) {
      active.status = 'blocked'
      await writeGoal(active)
      await execCmd('osascript', ['-e', `display notification "Goal blocked: ${active.goal.slice(0, 80)}" with title "Pi Goal"`], {}).catch(() => {})
      return `⚠️ Goal blocked!

Goal: ${active.goal}
Blocked at iteration ${blockedIteration.iteration} (${blockedIteration.role}):
${blockedIteration.assessment}

Suggestions:
- Address the blocker and run "pi goal iterate"
- Run "pi goal pause" to pause
- Run "pi goal clear" to abandon`
    }

    // Not met yet
    active.status = 'executing'
    await writeGoal(active)

    return `Goal not yet met.

Goal: ${active.goal}
Verification: ${active.verification}
Iterations completed: ${completedIterations.length}
Workers spawned: ${active.workerIds.length}

Latest handoffs:
${handoffSummaries.join('\n\n')}

Next steps:
- Run "pi goal iterate" to plan next iteration
- Spawn more workers targeting remaining work`
  }

  // Set a new goal — everything else is treated as the goal text
  const goalText = trimmed.replace(/^pi\s+goal\s+/i, '').replace(/^\/goal\s+/i, '')

  // Parse optional flags
  let verification = ''
  let constraints = ''
  let maxIterations = 10
  let model = DEFAULT_COORDINATOR_MODEL

  const vMatch = goalText.match(/--verify\s+"([^"]+)"/)
  if (vMatch) { verification = vMatch[1] }
  const cMatch = goalText.match(/--constraints?\s+"([^"]+)"/)
  if (cMatch) { constraints = cMatch[1] }
  const mMatch = goalText.match(/--max-iterations?\s+(\d+)/)
  if (mMatch) { maxIterations = parseInt(mMatch[1]) }
  const mmMatch = goalText.match(/--model\s+(\S+)/)
  if (mmMatch) { model = mmMatch[1] }

  // Remove flags from goal text
  let cleanGoal = goalText
    .replace(/--verify\s+"[^"]+"/, '')
    .replace(/--constraints?\s+"[^"]+"/, '')
    .replace(/--max-iterations?\s+\d+/, '')
    .replace(/--model\s+\S+/, '')
    .replace(/\s+/g, ' ')
    .trim()

  // Remove surrounding quotes
  if ((cleanGoal.startsWith('"') && cleanGoal.endsWith('"')) || (cleanGoal.startsWith("'") && cleanGoal.endsWith("'"))) {
    cleanGoal = cleanGoal.slice(1, -1)
  }

  if (!cleanGoal) return 'Please provide a goal objective. Example: pi goal "Fix all vault policy conflicts"'

  if (!verification) verification = inferVerification(cleanGoal)

  const id = shortId()
  const goal: GoalRecord = {
    id,
    goal: cleanGoal,
    verification,
    constraints,
    status: 'planning',
    model,
    maxIterations,
    currentIteration: 0,
    workerIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  await mkdir(path.join(ROOT, id), { recursive: true })
  await writeGoal(goal)
  await writeIterations(id, [])

  // Write goal markdown
  await writeFile(path.join(ROOT, id, 'goal.md'), `# Pi Goal

## Objective

${cleanGoal}

## Verification

${verification}

${constraints ? `## Constraints\n\n${constraints}` : ''}

## Status

- Status: planning
- Max iterations: ${maxIterations}
- Coordinator model: ${model}
- Created: ${goal.createdAt}

## Iterations

(No iterations yet. Run "pi goal iterate" to plan the first iteration.)
`, 'utf8')

  const roles = suggestRoles(cleanGoal)

  return `Goal created: ${id}

Objective: ${cleanGoal}
Verification: ${verification}
Constraints: ${constraints || 'none'}
Max iterations: ${maxIterations}
Coordinator model: ${model}
Suggested roles: ${roles.join(', ')}

Next steps:
1. Run "pi goal iterate" to plan the first iteration
2. Workers will be spawned for each role
3. Run "pi goal evaluate" after workers complete to check progress
4. Repeat until goal is achieved

The goal persists across iterations. Workers produce handoffs, and you evaluate progress.`
}

async function listGoals(): Promise<GoalRecord[]> {
  await ensureRoot()
  const dirs = await.readdirSafe(ROOT)
  const goals: GoalRecord[] = []
  for (const dir of dirs) {
    const goal = await readGoal(dir)
    if (goal) goals.push(goal)
  }
  return goals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const { execFile } = require('node:child_process')
    return await new Promise<string[]>((resolve) => {
      const fs = require('node:fs')
      fs.readdir(dir, { withFileTypes: true }, (err: any, entries: any[]) => {
        if (err) { resolve([]); return }
        resolve(entries.filter((e: any) => e.isDirectory()).map((e: any) => e.name))
      })
    })
  } catch {
    return []
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand('pi-goal', {
    description: 'Set and manage persistent goals that coordinate Pi Workers across iterations',
    handler: async (args, ctx) => {
      try {
        const result = await handleGoalCommand(`pi goal ${args}`, ctx)
        ctx.ui.notify(result, 'info')
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
      }
    },
  })

  pi.on('input', async (event, ctx) => {
    if (!/^pi\s+goal(?:s)?\b/i.test(event.text.trim()) && !/^\/goal\b/i.test(event.text.trim())) return { action: 'continue' }
    try {
      const result = await handleGoalCommand(event.text, ctx)
      ctx.ui.notify(result, 'info')
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error')
    }
    return { action: 'handled' }
  })

  pi.registerTool({
    name: 'pi_goal',
    label: 'Pi Goal',
    description: 'Set and manage persistent goals that coordinate Pi Workers across iterations. Goals define measurable completion conditions and spawn role-appropriate workers in iteration loops until the objective is achieved.',
    promptSnippet: 'Set and manage persistent goals that coordinate Pi Workers',
    promptGuidelines: [
      'Use pi_goal when the user wants to achieve a multi-step objective that requires multiple workers and iterations.',
      'pi_goal creates a durable goal state, suggests worker roles, and evaluates handoff progress against the completion condition.',
      'Each iteration spawns workers, collects handoffs, and evaluates whether the goal is met.',
      'The coordinator uses a cheap model (deepseek-v4-flash by default) to evaluate progress.',
    ],
    parameters: Type.Object({
      action: StringEnum(['set', 'status', 'pause', 'resume', 'clear', 'iterate', 'evaluate', 'list', 'iterations'] as const),
      goal: Type.Optional(Type.String({ description: 'The objective to achieve' })),
      verification: Type.Optional(Type.String({ description: 'How to verify the goal is met' })),
      constraints: Type.Optional(Type.String({ description: 'What must not regress' })),
      maxIterations: Type.Optional(Type.Number({ description: 'Maximum iterations (default 10)' })),
      model: Type.Optional(Type.String({ description: 'Coordinator model for evaluation (default deepseek-v4-flash)' })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === 'list') {
        return { content: [{ type: 'text', text: await (async () => { const goals = await listGoals(); return goals.length === 0 ? 'No goals yet.' : goals.map((g) => `${g.status.padEnd(12)} ${g.id}  ${g.currentIteration} iters  "${g.goal.slice(0, 80)}"`).join('\n'); })() }] }
      }

      if (params.action === 'set') {
        if (!params.goal) throw new Error('set requires goal text')
        const goalText = `${params.goal}${params.verification ? ` --verify "${params.verification}"` : ''}${params.constraints ? ` --constraints "${params.constraints}"` : ''}${params.maxIterations ? ` --max-iterations ${params.maxIterations}` : ''}${params.model ? ` --model ${params.model}` : ''}`
        const result = await handleGoalCommand(`pi goal ${goalText}`, ctx)
        return { content: [{ type: 'text', text: result }] }
      }

      // All other actions delegate to handleGoalCommand
      const commandText = `pi goal ${params.action}`
      const result = await handleGoalCommand(commandText, ctx)
      return { content: [{ type: 'text', text: result }] }
    },
  })

  pi.on('session_start', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus('pi-goal', 'pi-goal ready')
  })

  pi.on('session_shutdown', (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus('pi-goal', undefined)
  })
}