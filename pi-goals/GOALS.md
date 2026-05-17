# Pi Goals

This directory stores persistent goal state. Each goal gets a subdirectory with:

- `goal.md` — the objective, verification surface, and constraints
- `goal.json` — machine-readable state
- `iterations.json` — iteration history

The goal coordinator uses a cheap model (default: deepseek-v4-flash) to evaluate progress. Workers use role-appropriate models from Pi Workers config.

## How it works

1. Set a goal with measurable completion condition
2. Coordinator decomposes into worker subtasks
3. Workers execute and produce handoffs
4. Coordinator evaluates handoffs against goal
5. If not met, plan next iteration
6. If blocked, report blocker
7. If met, done — macOS notification

## Directory layout

```
~/.pi/agent/pi-goals/
├── GOALS.md          (this file)
├── <goal-id>/
│   ├── goal.md
│   ├── goal.json
│   └── iterations.json
```
