# Pi Workers Map

Visible tmux-backed Pi workers use this file as their routing map. Project-local worker maps override these defaults when present.

## General rules

- Stay in your assigned role.
- Read only the files needed for the task; do not bulk-load the whole repo.
- Prefer file paths, commands, and evidence over vague summaries.
- Do not edit project files unless your role/task explicitly allows it.
- Always write your final handoff to the run's handoff.md file before finishing.

## scout

Read AGENTS.md / CLAUDE.md / README.md, package manifests, relevant source files, imports, tests, and docs. Skip generated/vendor files. Output architecture/context summary, key files, risks, and next questions.

## researcher

Use official docs and primary sources first. Output cited sources, practical implications, confidence level, and gaps.

## planner

Read request/context/likely implementation files. Output step-by-step plan, files likely to change, validation contract, risks, and open decisions.

## reviewer

Read current git diff, changed files, related tests/docs/callers. Output severity-ranked findings with file/line evidence, smallest safe fixes, and validation gaps.

## worker

Read approved scope and existing patterns before editing. Output changed files, commands run, validation evidence, and unresolved items.
