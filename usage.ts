import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USAGE_PROMPT = String.raw`Create a Pi usage report for all of my Pi sessions over the last 1, 7, 30, and 90 days.

Goal:
- Produce a clean Markdown table for each window: 1 day, 7 days, 30 days, 90 days.
- For each model in each window, show source/app, model/provider, assistant messages or turns counted, input tokens, output tokens, cached input/read tokens, total tokens, and price in USD.
- Include a grand total row for each window.
- Use current model pricing from models.dev, not stale local assumptions.

Detailed steps:
1. Find all Pi session JSONL files under ~/.pi/agent/sessions recursively.
2. Also find Codex CLI session JSONL files under ~/.codex/sessions recursively and ~/.codex/archived_sessions if present.
3. Use timestamps to include sessions/messages/turns from the last 1, 7, 30, and 90 days relative to now.
4. Parse every JSONL line safely. Ignore malformed lines, but mention skipped lines.
5. Count only Pi assistant message entries that have model usage data.
6. For Codex CLI token_count events, use payload.info.last_token_usage to avoid double-counting cumulative totals.
7. Group by source plus stable model key.
8. Fetch/read pricing from models.dev without loading the entire API response into the conversation. Use shell scripts to fetch/process locally and print only matched pricing records.
9. Compute price carefully from input, output, and cached input/read rates.
10. Present concise Markdown sections: Last 1 day, Last 7 days, Last 30 days, Last 90 days.
11. Add a short Pricing notes section with lookup date, unmatched models, assumptions, and skipped lines if any.

Do not modify any session files.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Ask the agent to summarize Pi usage and cost for the last 1, 7, 30, and 90 days",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage(USAGE_PROMPT);
    },
  });
}
