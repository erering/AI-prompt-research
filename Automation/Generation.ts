import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";

const TASK_DIR = "Research/Tasks";
const PROMPTS_DIR = "Research/Prompts";
const RUNS_DIR = "Research/Runs";
const STYLE_SOURCE_PATH = "Research/Prompts/Prompt_Strategy_MetaData";

const MODEL_ID = "gpt-5.5";
const AICODE_FILENAME = "AiCode.txt";

const TASK_NAMES = [
  "Prisoner_Challenge",
  "Message",
  "Migrations",
  "Maximum_Clique_Size",
  "Number_Partitioning",
];
const PROMPT_COUNT = 9;
const ITERATIONS = 9;

const PROMPT_BATCH_TIMEOUT_MS = 1000 * 60 * 60 * 4;
const SOLVER_TIMEOUT_MS = 1000 * 60 * 60 * 4;

const PROMPT_REASONING = "high" as const;
const SOLVER_REASONING = "medium" as const;

// ---------------- utils ----------------

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function readText(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

async function writeText(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, "utf8");
}

function stripCodeFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return (m ? m[1] : t).trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------- task resolution ----------------

async function resolveTaskFile(taskName: string): Promise<string> {
  const candidates = [
    path.join(TASK_DIR, taskName),
    path.join(TASK_DIR, `${taskName}.md`),
    path.join(TASK_DIR, `${taskName}.txt`),
    path.join(TASK_DIR, `${taskName}.markdown`),

    path.join(TASK_DIR, taskName.replace(/\.(txt|md|markdown)$/i, "")),
    path.join(TASK_DIR, `${taskName.replace(/\.(txt|md|markdown)$/i, "")}.md`),
    path.join(TASK_DIR, `${taskName.replace(/\.(txt|md|markdown)$/i, "")}.txt`),
  ];

  for (const candidate of candidates) {
    const st = await statSafe(candidate);
    if (!st) continue;

    if (st.isFile()) return candidate;

    if (st.isDirectory()) {
      const preferredInside = [
        "task.md",
        "task.txt",
        "statement.md",
        "statement.txt",
        "problem.md",
        "problem.txt",
        "README.md",
        "readme.md",
      ];

      for (const inner of preferredInside) {
        const innerPath = path.join(candidate, inner);
        if (await exists(innerPath)) return innerPath;
      }

      const entries = await fs.readdir(candidate, { withFileTypes: true });

      const files = entries
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .filter((name) => !name.startsWith("."))
        .sort();

      if (files.length > 0) {
        return path.join(candidate, files[0]);
      }
    }
  }

  throw new Error(`Task file not found for "${taskName}"`);
}

// ---------------- style resolution ----------------

async function resolveStyleSource(): Promise<string> {
  const st = await statSafe(STYLE_SOURCE_PATH);

  if (!st) {
    throw new Error(`Style source not found: ${STYLE_SOURCE_PATH}`);
  }

  if (st.isFile()) return STYLE_SOURCE_PATH;

  if (st.isDirectory()) {
    const preferredInside = [
      "styles.json",
      "styles.txt",
      "Prompt_Strategy_MetaData.json",
      "Prompt_Strategy_MetaData.txt",
      "Prompt_Strategy_MetaData.md",
      "metadata.json",
      "metadata.txt",
      "metadata.md",
    ];

    for (const inner of preferredInside) {
      const innerPath = path.join(STYLE_SOURCE_PATH, inner);
      if (await exists(innerPath)) return innerPath;
    }

    const entries = await fs.readdir(STYLE_SOURCE_PATH, {
      withFileTypes: true,
    });

    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("."))
      .sort();

    if (files.length > 0) {
      return path.join(STYLE_SOURCE_PATH, files[0]);
    }
  }

  throw new Error(`Could not resolve style file inside ${STYLE_SOURCE_PATH}`);
}

// ---------------- styles ----------------

function loadStyles(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return parsed
        .map(String)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, PROMPT_COUNT);
    }
  } catch {}

  const styles: string[] = [];
  const lines = raw.split(/\r?\n/).map((s) => s.trim());

  for (const line of lines) {
    if (!line) continue;

    const match = line.match(/^\s*Prompt\s*\d+\s*:\s*(.+)$/i);

    if (match) {
      styles.push(match[1].trim());
      continue;
    }

    styles.push(line);
  }

  return styles.slice(0, PROMPT_COUNT);
}

// ---------------- openai ----------------

function makeClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  return new OpenAI({
    apiKey,
    timeout: 1000 * 60 * 60 * 4,
    maxRetries: 0,
  });
}

// ---------------- timeout ----------------

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return await promise;
  }

  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms while ${label}`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retryWaitMs(err: any, attempt: number): number {
  const retryAfter = Number(err?.headers?.get?.("retry-after")) || 0;
  return retryAfter > 0 ? retryAfter * 1000 : Math.min(120000, 5000 * attempt);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------- solver ----------------

async function callTextModel(
  prompt: string,
  timeoutMs: number,
  label: string
): Promise<string> {
  const client = makeClient();
  const MAX_RETRIES = 50;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`→ solver request (${label}) attempt ${attempt}`);

      const response = await withTimeout(
        client.responses.create({
          model: MODEL_ID,
          reasoning: {
            effort: SOLVER_REASONING,
          },
          input: prompt,
        }),
        timeoutMs,
        label
      );

      console.log(`← solver response (${label})`);

      return stripCodeFences(response.output_text ?? "");
    } catch (err: any) {
      console.error(`Solver request failed on attempt ${attempt} for ${label}`);

      if (attempt === MAX_RETRIES) {
        throw err;
      }

      const waitMs = retryWaitMs(err, attempt);
      console.log(`Retrying in ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }
  }

  throw new Error("Unreachable");
}

// ---------------- prompt generation ----------------

async function generatePromptBatch(
  taskText: string,
  styles: string[]
): Promise<string[]> {
  const client = makeClient();
  const MAX_RETRIES = 50;

  const prompt = [
    `You will generate exactly ${PROMPT_COUNT} solver prompts for another AI.`,
    "",
    "STRICT REQUIREMENTS:",
    "- produce exactly one prompt per style, in the same order as the styles are listed",
    "- the first output must follow Prompt 1 style, the second output Prompt 2 style, and so on",
    "- prompts must be fully self-contained",
    "- never mention contest names or sources",
    "- never mention task names",
    "- solver must output ONLY valid C++20 code",
    "- no markdown",
    "- no explanation",
    "- no code fences",
    "",
    "Task:",
    taskText,
    "",
    "Styles:",
    ...styles.map((style, i) => `${i + 1}. ${style}`),
    "",
    'Return JSON only in the form: {"prompts":["..."]}',
  ].join("\n");

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`→ prompt generation request attempt ${attempt}`);

      const response = await withTimeout(
        client.responses.create({
          model: MODEL_ID,
          reasoning: {
            effort: PROMPT_REASONING,
          },
          input: prompt,
          text: {
            format: {
              type: "json_schema",
              name: "prompt_batch",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  prompts: {
                    type: "array",
                    minItems: PROMPT_COUNT,
                    maxItems: PROMPT_COUNT,
                    items: {
                      type: "string",
                    },
                  },
                },
                required: ["prompts"],
              },
            },
          },
        }),
        PROMPT_BATCH_TIMEOUT_MS,
        "generating prompt batch"
      );

      console.log("← prompt generation response");

      const raw = stripCodeFences(response.output_text ?? "");
      const parsed = JSON.parse(raw);

      if (
        !parsed ||
        !Array.isArray(parsed.prompts) ||
        parsed.prompts.length !== PROMPT_COUNT
      ) {
        throw new Error(
          `Prompt batch did not return exactly ${PROMPT_COUNT} prompts`
        );
      }

      return parsed.prompts.map((x: unknown) => String(x).trim());
    } catch (err: any) {
      console.error(`Prompt generation failed on attempt ${attempt}`);

      if (attempt === MAX_RETRIES) {
        throw err;
      }

      const waitMs = retryWaitMs(err, attempt);
      console.log(`Retrying in ${Math.round(waitMs / 1000)}s...`);
      await sleep(waitMs);
    }
  }

  throw new Error("Unreachable");
}

function addSolverGuard(prompt: string): string {
  return [
    prompt.trim(),
    "",
    "Hard constraints:",
    "- Output only valid C++20 code.",
    "- No markdown.",
    "- No explanation.",
    "- No code fences.",
  ].join("\n");
}

async function savePromptFiles(
  promptsRoot: string,
  promptTexts: string[]
): Promise<void> {
  await fs.mkdir(promptsRoot, { recursive: true });

  for (let i = 0; i < PROMPT_COUNT; i++) {
    const out = path.join(promptsRoot, `Prompt-${pad2(i + 1)}.txt`);
    await writeText(out, promptTexts[i]);
    console.log(`[saved] ${out}`);
  }
}

// ---------------- task runner ----------------

async function runTask(taskName: string) {
  const taskFile = await resolveTaskFile(taskName);
  const taskText = await readText(taskFile);

  const styleFile = await resolveStyleSource();
  const styleRaw = await readText(styleFile);
  const styles = loadStyles(styleRaw);

  if (styles.length < PROMPT_COUNT) {
    throw new Error(`Need at least ${PROMPT_COUNT} styles, found ${styles.length}`);
  }

  const promptsRoot = path.join(PROMPTS_DIR, taskName);
  const runsRoot = path.join(RUNS_DIR, taskName);

  await fs.mkdir(runsRoot, { recursive: true });

  console.log(`\n=== ${taskName} ===`);

  const promptTexts = await generatePromptBatch(taskText, styles);

  await savePromptFiles(promptsRoot, promptTexts);

  for (let promptIdx = 1; promptIdx <= PROMPT_COUNT; promptIdx++) {
    const solverPrompt = addSolverGuard(promptTexts[promptIdx - 1]);

    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const iterationDir = path.join(
        runsRoot,
        `Prompt-${pad2(promptIdx)}`,
        `${pad2(iteration)}-iteration`
      );

      await fs.mkdir(iterationDir, { recursive: true });

      console.log(`→ solving P${pad2(promptIdx)} I${iteration}`);

      const code = await callTextModel(
        solverPrompt,
        SOLVER_TIMEOUT_MS,
        `solving ${taskName} P${pad2(promptIdx)} I${iteration}`
      );

      await writeText(path.join(iterationDir, AICODE_FILENAME), code);
      console.log(`← saved P${pad2(promptIdx)} I${iteration}`);
    }
  }

  console.log(`Done: ${taskName}`);
}

// ---------------- main ----------------

async function main() {
  for (const taskName of TASK_NAMES) {
    await runTask(taskName);
  }
  console.log("\nAll tasks done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
