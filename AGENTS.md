# Global AGENTS.md

Default instructions for Pi coding agents on this machine.

## Principles
- Be concise and practical.
- Make the smallest useful change.
- Avoid unrelated refactors or redesigns.

## Workflow
- Read relevant files before editing; read full files rather than subsets so important context is not missed.
- State intent briefly when helpful.
- Ask questions one at a time.
- Prefer targeted edits over broad rewrites.
- Validate with focused checks, formatters, linters, or tests when available.
- Avoid running dev servers or build commands unless necessary; ask first if they are needed.

## User Knowledge Base
- The user's primary Obsidian knowledge base is TheBrain at `/Users/jlin/Documents/Obsidian/TheBrain`.
- This vault contains notes for content, projects, brand, building/dev tools, scripts, outputs, and raw inbox material.
- When the user asks about content strategy, personal brand, scripts, project context, dev-tool research, existing notes, or "what do I know about X", check this vault first when useful.
- Use `/Users/jlin/Documents/Obsidian/TheBrain/wiki/_master-index.md` as the main navigation entry point.
- Respect the vault conventions in `/Users/jlin/Documents/Obsidian/TheBrain/CLAUDE.md` when editing or organizing notes.
- Do not move, delete, or broadly reorganize vault files unless explicitly requested.

## TypeScript
- Add packages with the project's package manager install command; do not manually edit `package.json` for dependencies.
- Run the project's check, format, and/or lint commands after making changes.
- If check/format/lint scripts do not exist, suggest adding them.
- Avoid explicit return types unless they are necessary for clarity, exported APIs, overloads, recursion, or type safety.
- Treat `as any` as an absolute last resort; prefer real type safety and inference.
- Lean on type inference instead of manually adding new types unnecessarily.

## Code Quality
- Follow existing project patterns.
- Keep code clear, modular, and readable.
- Add abstractions only when they reduce duplication or clarify intent.

## Safety
- Ask before broad, risky, or destructive changes.
- Do not delete data unless explicitly requested.
