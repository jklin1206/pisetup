---
name: council
description: Convene a multi-perspective council to evaluate plans, architecture decisions, product choices, code strategies, tradeoffs, or risky actions. Use when the user asks for a council, panel, contrarian review, devil's advocate, second opinions, multiple viewpoints, or a synthesized recommendation.
---

# Council Skill

Use this skill to run a structured, multi-perspective review. This is a **prompt-level council**, not a true multi-model extension. Do not claim that separate models or processes were invoked unless an actual extension/tool was used. Instead, simulate distinct expert perspectives and synthesize them into one practical recommendation.

## When to Use

Use when the user asks for:

- a council
- a panel of opinions
- contrarian review
- devil's advocate
- different viewpoints
- architecture critique
- plan review
- product/UX/engineering tradeoff review
- “what am I missing?”
- “is this a good idea?”

## Core Behavior

Run the council in four stages:

1. **Frame the question** — restate the decision or plan being reviewed.
2. **Council perspectives** — give distinct viewpoints from several roles.
3. **Disagreements and tradeoffs** — identify where council members disagree and why.
4. **Final synthesis** — provide a concrete recommendation, next steps, and risks.

Be concise unless the user asks for depth.

## Default Council Members

Choose 4-7 relevant members. Use these defaults unless a different panel fits better:

### Architect
Focuses on structure, interfaces, maintainability, abstractions, and long-term coherence.

### Contrarian
Challenges assumptions, asks whether the plan is solving the wrong problem, and argues against premature complexity.

### Implementer
Focuses on how to actually build it, sequencing, dependencies, rough edges, and hidden work.

### Reliability Engineer
Focuses on failure modes, observability, validation, testing, recovery, and operational risk.

### Security / Safety Reviewer
Focuses on permissions, data exposure, destructive actions, trust boundaries, and misuse.

### Product / User Advocate
Focuses on the user-visible value, workflow clarity, cognitive load, and whether the feature matters.

### Minimalist
Focuses on the smallest useful version, what to cut, and what can be deferred.

## Optional Council Members

Add only when useful:

- **Performance Engineer** — latency, cost, scaling, resource use
- **Design Critic** — UX, visual hierarchy, interaction model
- **Researcher** — external facts, prior art, evidence quality
- **Maintainer** — support burden, docs, backward compatibility
- **Operator** — CLI/TUI ergonomics and day-to-day workflow
- **Finance/Cost Reviewer** — API costs, opportunity cost, maintenance cost

## Output Format

Use this format by default:

```md
## Council Review

### Question / Plan
[One-paragraph restatement]

### Perspectives

**Architect:** ...

**Contrarian:** ...

**Implementer:** ...

**Reliability:** ...

**Product:** ...

### Key Disagreements
- ...
- ...

### Final Recommendation
[Clear verdict]

### Next Steps
1. ...
2. ...
3. ...

### Watchouts
- ...
```

For small questions, compress to:

```md
## Council Verdict
[Recommendation]

- **Best argument for:** ...
- **Best argument against:** ...
- **What to do next:** ...
```

## Decision Quality Rules

- Prefer actionable synthesis over equal-weight opinion listing.
- Surface disagreement; do not force fake consensus.
- Name the riskiest assumption.
- Separate “must do now” from “nice later.”
- Avoid generic advice. Tie comments to the user's actual context.
- If evidence is missing, say what would change the recommendation.
- If the plan is too broad, recommend an MVP.
- If the user asks for implementation, end with a concrete build sequence.

## Council Modes

### Plan Review
Use for architecture or implementation plans.

Focus:
- Is this the right abstraction?
- What can be simplified?
- What should be built first?
- What are likely failure modes?

### Contrarian Council
Use when user explicitly wants opposition.

Include at least:
- strongest objection
- why the plan may fail
- what would invalidate the objection
- safer alternative

### Build Council
Use before coding.

End with:
- MVP scope
- file/module candidates if known
- validation steps
- deferred features

### Postmortem Council
Use after something went wrong.

Focus:
- root causes
- detection gaps
- prevention
- repair plan

### Product Council
Use for feature/value decisions.

Focus:
- user value
- workflow fit
- cognitive load
- adoption risk
- what to cut

## Important Limitations

This skill alone does not:

- call multiple external models
- spawn subagents
- run parallel tool-using agents
- create child Pi sessions
- perform anonymized peer ranking with actual independent models

If the user asks for a real multi-model council or true subagents, explain that this requires an extension/tool. You may still provide a prompt-level council immediately if useful.
