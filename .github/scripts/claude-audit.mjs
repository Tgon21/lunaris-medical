/**
 * Judgment half of the standing audit — the part a grep can't do. Ported from
 * ecom-flooraction's audit flow.
 *
 * Reads the last day's diff and asks Claude for logic bugs, permission leaks,
 * and security slips. Deterministic checks (dependency CVEs, secret scan) live
 * in the workflow itself — this is for what needs reading, not matching.
 * Prints markdown to stdout; the workflow folds it into the rolling issue.
 * Never throws hard: a bad review must not fail the sweep.
 *
 * Gated on ANTHROPIC_API_KEY (the workflow skips this step without it).
 */
import { execFileSync } from "node:child_process";

const MODEL = "claude-sonnet-5"; // cheap enough for 3x/day; Opus if it starts missing things
const MAX_DIFF = 180_000; // ~45k tokens of diff; older/larger sweeps get truncated, not dropped

function sh(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return "";
  }
}

const EXCLUDES = [":(exclude)package-lock.json", ":(exclude)*.lock", ":(exclude)cache.json"];

// What changed in the last day. Fall back to the last 20 commits if the window is
// empty (quiet day) so the sweep still says something useful.
let diff = sh(["diff", "--unified=3", "HEAD@{1.day.ago}", "HEAD", "--", ".", ...EXCLUDES]);
if (!diff.trim()) diff = sh(["diff", "--unified=3", "HEAD~20", "HEAD", "--", ".", ...EXCLUDES]);
if (!diff.trim()) {
  console.log("_No code changes in the review window._");
  process.exit(0);
}
const truncated = diff.length > MAX_DIFF;
if (truncated) diff = diff.slice(0, MAX_DIFF);

const SYSTEM = `You are reviewing a diff from a static HTML marketing/concept site for a medical practice. Watch for leaked credentials, PII in page content, and XSS in any inline scripts.

Look for defects that matter in production:

1. AUTHORIZATION/ACCESS: endpoints, pages, or handlers that skip an auth check,
   trust client-supplied identity, or leak data across users/tenants.
2. INJECTION & INPUT HANDLING: SQL/command/HTML injection, unsafe interpolation,
   unvalidated input reaching a sensitive sink.
3. SECRETS & PII: credentials or personal data committed, logged, or exposed to
   the client that should stay server-side.
4. LOGIC BUGS: changes whose behavior contradicts their evident intent — off-by-one,
   inverted condition, missed error path — where the failure has real consequences.

Report ONLY defects you can point at in this diff. For each: what breaks, and the concrete
path to it. Rank by severity. If a change is fine, say nothing about it — no praise, no
summary of what changed. Prefer silence to speculation: a false alarm costs more than a miss
here, because this runs three times a day and a noisy report gets ignored.`;

const PROMPT = `Review this diff.${truncated ? " (Truncated — review what is present.)" : ""}

Output GitHub-flavored markdown:
- If you find nothing real: exactly the line \`_No issues found in recent changes._\` and nothing else.
- Otherwise, one \`### <severity>: <one-line title>\` per finding, then 1-3 sentences: the concrete
  failure (inputs/state -> wrong outcome) and the file:line. Max 6 findings, worst first.

\`\`\`diff
${diff}
\`\`\``;

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{ role: "user", content: PROMPT }],
  }),
});

if (!res.ok) {
  console.log(`_Claude review unavailable (HTTP ${res.status}). The deterministic checks above still ran._`);
  process.exit(0);
}

const data = await res.json();
const text = (data?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
console.log(text || "_No issues found in recent changes._");
if (truncated) console.log("\n<sub>Diff was truncated to fit the review window.</sub>");
