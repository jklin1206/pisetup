# Pi Setup

My Pi coding agent configuration, extensions, skills, and themes.

## Contents

- `AGENTS.md` — global agent instructions
- `settings.json` — Pi default settings
- `mcp.json` — MCP server config
- `extensions/` — custom extensions
  - `pi-workers/` — Pi Workers v2 (role-based model routing, handoffs, notifications)
  - `pi-goal/` — Goal coordinator (persistent objectives, iteration loops, worker orchestration)
  - `ask-user-question.ts`, `auto-workflow/`, `model-router/`, etc.
- `pi-workers/` — Pi Workers config + routing map
- `pi-goals/` — Goal coordinator routing map
- `skills/` — custom skills
- `themes/` — UI themes

## Key concepts

### Pi Workers
Role-based worker sessions in tmux with:
- Model routing per role (scout=deepseek-flash, researcher=kimi, planner=glm, reviewer=glm, worker=default)
- Handoff files for structured output
- macOS notifications on completion
- `completed` and `exit-code` markers for programmatic waiting

### Pi Goals
Persistent objectives that coordinate Pi Workers across iterations:
- Set a goal with verification condition
- Coordinator (cheap model) decomposes into subtasks
- Spawns role-appropriate workers
- Evaluates handoffs against goal
- Loops until goal is met or blocked
- macOS notification on completion

## Usage

```bash
# Pi Workers
pi worker scout "audit this repo"
pi worker researcher "compare X libraries"
pi worker list
pi worker handoff <id>
pi worker wait <id>         # blocks until worker finishes

# Pi Goals
pi goal "Fix all vault policy conflicts verified by review"
pi goal status
pi goal iterate             # plan next iteration
pi goal evaluate            # check progress
pi goal pause / resume / clear
```
