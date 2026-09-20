import PROMPT_DISTILL from "./template/distill.txt"
import PROMPT_SCHEDULE from "./template/schedule.txt"
import PROMPT_COUNCIL from "./template/council.txt"

// Personalization commands (/distill, /schedule, /council). Isolated in ONE
// owned file so the upstream command/index.ts patch stays a fixed 2-line delta;
// adding a command changes only this list, never the index.ts hunk.
export const CUSTOM_COMMANDS: { name: string; description: string; template: string }[] = [
  {
    name: "distill",
    description: "distill this session into a reusable skill (RSI, deterministic)",
    template: PROMPT_DISTILL,
  },
  {
    name: "schedule",
    description: "run qm-style background schedules that are due (deterministic crons)",
    template: PROMPT_SCHEDULE,
  },
  {
    name: "council",
    description: "convene a multi-model council (council/compare/debate/moa/router/consensus/arena)",
    template: PROMPT_COUNCIL,
  },
]
