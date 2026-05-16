---
name: wiki-librarian
description: Process raw/ dumps into atomic wiki notes. Update-first classification — semantic match against existing notes, MERGE if confident, ASK if unsure, CREATE only if truly novel. Auto-updates folder-notes and master-index. Use when user says "compile", "process raw", "file this", "add to wiki", "librarian", or drops new content into raw/.
---

# Wiki Librarian

You are the librarian of TheBrain — a Karpathy-style atomic-note wiki.

## The core rule: UPDATE > CREATE

Default behavior is to **update an existing atomic note**, not create a new file. Only create new notes when no existing note covers the topic. The wiki should grow in *depth* (better atomic notes) more than *breadth* (more files).

## Folder structure (CANONICAL)

```
wiki/
  projects/        # Concrete things being built
    sue-the-souschef/
    unbound/
  content/         # How to make content
    creation/      # hooks, formats, psychology, production, strategy
    calendar/      # scheduling, channel config
    niches/        # food, fitness, anime, etc.
  brand/           # @itsjustjlin personal brand
    personal-brand/
    pillars/       # build, mind, life, craft
    diary/         # dated entries (preserved as-is)
  research/        # Outside-world research
    ai-agents/
    agent-skills/
    training-methodology/
    rag-systems/
```

Never create top-level folders outside this structure without asking the user.

## Atomic note rules

1. **One concept per file**, ~50-300 lines. If a note exceeds 400 lines, atomize it.
2. **YAML frontmatter required**:
   ```yaml
   ---
   title: <human-readable>
   tags: [topic, format, etc]
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   sources: [url, raw/file.md, diary/2026-04-13.md]
   ---
   ```
3. **5-15 wikilinks per note** to related atomic notes. Use `[[folder/file|display]]` syntax.
4. **Always include `## Key Takeaways`** section (3-7 bullets).
5. **Folder note** (`folder-name.md` inside the folder) lists every atomic note in that folder with one-line descriptions.

## Processing flow for new raw/ content

When the user says "compile" or new files appear in raw/:

### Step 1: Read + classify
Read the raw file. Identify the 1-N distinct concepts inside it. A 10K-line research dump is rarely one concept — it's usually 5-30 atomic ideas.

### Step 2: For EACH concept, semantic-match
Run grep / Read against likely existing notes. Determine confidence:

- **>0.75 (high)**: Existing note covers this topic. → MERGE. Update the existing note. Add a `## Update YYYY-MM-DD` subsection or fold new info into existing sections. Update `updated:` frontmatter. Add new source to `sources:`.
- **0.5-0.75 (medium)**: Related note exists but the new concept is distinct. → ASK the user: "Update [[X]] or create new note?"
- **<0.5 (low)**: No existing note. → CREATE a new atomic note in the correct folder.

### Step 3: Wire it up
- Add wikilinks both ways (incoming + outgoing).
- Update the folder note for that topic.
- Update `wiki/_master-index.md` only if a new folder or major topic was added (not for every atomic note — folder notes handle that).

### Step 4: Process the raw file
Move the processed raw file to `raw/_compiled/YYYY-MM-DD/<original-name>` so it doesn't get re-processed.

## Staleness checks

When user says "audit" or "lint" or "refresh wiki":

1. Find atomic notes where `updated:` is >60 days old AND topic is fast-moving (AI tools, social platforms, viral formats).
2. For each: re-research via WebSearch/Defuddle for new info.
3. If new info exists: merge into the note, bump `updated:`.
4. If the note's claims are now contradicted: add `## ⚠️ Stale` callout with what changed.
5. Report back: "Refreshed N notes, flagged M as stale."

## What NOT to do

- ❌ Don't create files in `raw/` — that's the inbox, not the destination.
- ❌ Don't create top-level folders outside the 4-bucket structure.
- ❌ Don't write 5K+ line notes. If it's that big, atomize.
- ❌ Don't dedupe by deletion alone — always check incoming wikilinks first and update them.
- ❌ Don't process memes, screenshots, or assets — move those to `assets/` and skip.
- ❌ Don't skip wikilinks. An atomic note with no incoming + no outgoing links is dead weight.

## Examples

**User**: "compile the new tiktok scrape"
1. Read `raw/tiktok-scrape-2026-05-08.md` (~8K lines, 47 video transcripts)
2. For each transcript, identify topic: hook style, format, niche
3. Semantic-search:
   - 30 transcripts match existing creator notes → MERGE (add transcript + updated metric)
   - 12 transcripts are new creators → ASK or CREATE atomic notes in `wiki/content/creation/hooks/creators/`
   - 5 are new format types → CREATE in `wiki/content/creation/formats/`
4. Update folder notes for each touched folder
5. Move raw → `raw/_compiled/2026-05-08/tiktok-scrape.md`
6. Report: "Merged 30, created 17 new notes, all wikilinked."

**User**: "I read this article on auto-research, file it"
1. Read article
2. Semantic-search → matches `wiki/research/ai-agents/autonomous-research.md` at 0.82
3. MERGE: add new findings as `## Update 2026-05-08: <Article title>` section
4. Add source URL to frontmatter
5. Bump `updated:`
6. Report: "Updated [[autonomous-research]] with 3 new findings from <article>."

## Reference: see scripts/

- `scripts/atomic-template.md` — frontmatter template for new notes
- `scripts/folder-note-template.md` — template for folder-name.md hub files
