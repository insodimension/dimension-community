#!/usr/bin/env node
// Browser task-agent benchmark: drives each task agent through the practice world (bench/sites/server.mjs)
// via the pack's MCP server (app/server.mjs over stdio), scores every stage from /__results and writes a
// markdown report plus raw JSON to bench/results/.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderReport, summarize } from "./report.mjs";

const USAGE = `Usage: node bench/run.mjs [options]

Runs browser task agents against the local practice world and reports speed and accuracy per stage.

Scenarios (--scenario):
  jobs   One independent application per site; the world is reset before each site and the
         applicant uses the fixed example email. Sites: --sites (default acme,globex,initech,umbrella,hooli;
         also soylent,tyrell).
  full   Per agent, ONE browser and a chain of tasks in a fresh world:
           mail     create an @mail.test account (fake "I'm not a robot" check)
           network  sign up on Network with that address and verify it from the inbox
           profile  complete the Network profile wizard
           <job>    apply to each of the ten jobs with the created address: acme, globex, initech,
                    umbrella, hooli, network (find 1 of 20 postings + Easy Apply), wayne (Apply with
                    Network consent popup), cyberdyne (confirm from inbox), soylent (4-page wizard with
                    resume), tyrell (form in an iframe). --sites narrows the jobs.

Options:
  --scenario <name>   jobs | full (default: jobs)
  --agents <list>     Comma-separated task agents (default: jev,browser-use). "hybrid" runs
                      account stages with browser-use and each job with jev, falling back to
                      browser-use when jev does not finish it or stalls (20 s without a step, or two
                      waits in a row); the times of both are summed.
  --sites <list>      Comma-separated job sites (defaults above)
  --engine <name>     Browser engine for browser_open (default: chromium)
  --headed            Show the browser window (DIMENSION_BROWSER_HEADLESS=false)
  --port <n>          Practice world port; started in-process if not already running (default: 4777)
  --max-steps <n>     maxSteps passed to browser_task (default: 40)
  --timeout <sec>     Hard wall-clock limit per stage (default: 600)
  -h, --help          Show this help

Output: a scorecard on stdout, bench/results/<timestamp>.md (report) and <timestamp>.json (raw).
Model keys come from the environment: jev needs TYPESAFE_API_KEY and TEXT_MODEL_API_KEY (TEXT_MODEL,
TEXT_MODEL_BASE_URL optional); browser-use reads DIMENSION_BROWSER_USE_MODEL/_API_KEY/_BASE_URL.`;

const JOB_SITES = ["acme", "globex", "initech", "umbrella", "hooli", "network", "wayne", "cyberdyne", "soylent", "tyrell"];
const STANDALONE_SITES = ["acme", "globex", "initech", "umbrella", "hooli", "soylent", "tyrell"];
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const { values: opts } = parseArgs({
  options: {
    scenario: { type: "string", default: "jobs" },
    agents: { type: "string", default: "jev,browser-use" },
    sites: { type: "string" },
    engine: { type: "string", default: "chromium" },
    headed: { type: "boolean", default: false },
    port: { type: "string", default: "4777" },
    "max-steps": { type: "string", default: "40" },
    timeout: { type: "string", default: "600" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!["jobs", "full"].includes(opts.scenario)) {
  console.error(`Unknown scenario ${opts.scenario}. Known: jobs, full`);
  process.exit(2);
}
const full = opts.scenario === "full";
const allowed = full ? JOB_SITES : STANDALONE_SITES;
opts.sites ??= (full ? JOB_SITES : STANDALONE_SITES.slice(0, 5)).join(",");

const agents = list(opts.agents);
const sites = list(opts.sites);
const unknown = sites.filter((s) => !allowed.includes(s));
if (unknown.length) {
  console.error(`Unknown or unsupported site(s) for the ${opts.scenario} scenario: ${unknown.join(", ")}. Known: ${allowed.join(", ")}`);
  process.exit(2);
}
const maxSteps = Number(opts["max-steps"]);
const taskTimeoutMs = Number(opts.timeout) * 1000;

const packDir = fileURLToPath(new URL("../", import.meta.url));
const serverPath = fileURLToPath(new URL("../app/server.mjs", import.meta.url));
if (!existsSync(serverPath)) {
  console.error(`Missing ${serverPath}; run \`npm run build\` in packs/browser first.`);
  process.exit(2);
}
const applicant = JSON.parse(readFileSync(new URL("./applicant.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- practice world

const base = `http://127.0.0.1:${opts.port}`;
let sitesServer = null;
try {
  await fetch(`${base}/__results`);
} catch {
  const { startSites } = await import("./sites/server.mjs");
  sitesServer = (await startSites(Number(opts.port))).server;
  console.log(`[bench] started practice world on ${base}`);
}
const worldResults = async () => (await fetch(`${base}/__results`)).json();
const resetWorld = () => fetch(`${base}/__reset`, { method: "POST" });

// ---------------------------------------------------------------- stages

const a = applicant;
// Task text names the password by this token, resolved per agent in runStage.
// jev never receives it: the browser fills password fields from the credential
// it holds for the bench profile (seeded below with the fixture). browser-use
// cannot take a credential (it reads password fields), so it gets the fixture
// in its task text; the value is a practice-site fixture, never a real secret.
const PASSWORD = "{{password}}";

const mailAddress = `${a.mailUsername}@mail.test`;
const birthday = new Date(`${a.birthday}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });

function applicantBlock(email) {
  return `First name: ${a.firstName}
Last name: ${a.lastName}
Full name: ${a.firstName} ${a.lastName}
Email: ${email}
Phone: ${a.phone}
City: ${a.city}
Current job title / headline: ${a.headline}
Years of professional experience: ${a.yearsExperience}
LinkedIn: ${a.linkedin}
Authorized to work in the US: ${a.workAuthorized ? "yes" : "no"}
Skills: ${a.skills.join(", ")}
Cover letter: ${a.coverLetter}
Resume (plain text): ${a.resume}`;
}

const jobGoal = (site) => (site === "network"
  ? `Find the full-time, Remote, Senior-level "Senior Frontend Engineer" posting from Stark Industries on the Network job board at ${base}/network/jobs (there are 20 postings; use the search and filters) and apply to it with Easy Apply`
  : `Apply to the Frontend Engineer job at ${base}/${site}`);

function legacyTask(site) {
  return `${jobGoal(site)} using this applicant:
${applicantBlock(a.email)}
Fill in every field the application form asks for using exactly this data, accept any required consent, and submit the application. You are done when the site confirms the application was received.`;
}

function fullJobTask(site) {
  return `${jobGoal(site)} using this applicant:
${applicantBlock(mailAddress)}
Fill in every field the application asks for using exactly this data, accept any required consent or cookie choice, and submit. The email address is ${mailAddress}.
You already have accounts, signed in in this browser: Mail at ${base}/mail and Network at ${base}/network, both ${mailAddress} with password ${PASSWORD}.
If the site offers "Apply with Network", use it and allow access. If the site emails you a confirmation link, open the Mail inbox at ${base}/mail, open that email and click its link.
You are done when the site confirms the application was received.`;
}

const fullStages = [
  {
    id: "mail", account: true, start: `${base}/mail`, score: (r) => r.stages.mailAccount,
    task: `Create a new email account at ${base}/mail (use "Create account").
First name: ${a.firstName}
Last name: ${a.lastName}
Birthday: ${birthday}
Choose your Mail address: ${a.mailUsername} (the page adds @mail.test itself, so the field holds only ${a.mailUsername}; your address becomes ${mailAddress})
Password: ${PASSWORD} (enter it in both password fields)
Then tick "I'm not a robot" and wait until it shows a check mark (it takes about a second) before pressing "Create account". You are done when the Mail inbox is shown.`,
  },
  {
    id: "network", account: true, start: `${base}/network`,
    score: (r) => {
      const s = r.stages.networkAccount;
      const success = s.created && s.emailMatchesMail && (s.missing ?? []).length === 0 && (s.wrong ?? []).length === 0;
      return { ...s, success, reason: success ? "ok" : s.reason };
    },
    task: `Join the professional network at ${base}/network ("Join now") with:
Email: ${mailAddress}
Password: ${PASSWORD}
First name: ${a.firstName}
Last name: ${a.lastName}
You are done when Network says it sent a verification email. Do not click "Resend email".`,
  },
  {
    id: "verify", account: true, start: `${base}/mail/inbox`, score: (r) => r.stages.networkAccount,
    task: `In the Mail inbox at ${base}/mail/inbox, open the email "Confirm your email address" from Network and click its confirm link. You are done when Network says your email is verified.`,
  },
  {
    id: "profile", account: true, start: `${base}/network/onboarding`, score: (r) => r.stages.profile,
    task: `Complete your Network profile wizard at ${base}/network/onboarding (you are signed in as ${mailAddress}; if asked, the password is ${PASSWORD}).
Headline: ${a.headline}
Location: ${a.city}, OR
Years of professional experience: ${a.yearsExperience}
Skills: add each of ${a.skills.join(", ")} as a separate skill
Go through every step and press Finish. You are done when your profile page shows 100% complete.`,
  },
  ...sites.map((site) => ({ id: site, start: site === "network" ? `${base}/network/jobs` : `${base}/${site}`, score: (r) => r.jobs[site], task: fullJobTask(site) })),
];
const jobStages = sites.map((site) => ({ id: site, start: `${base}/`, reset: true, score: (r) => r.jobs[site], task: legacyTask(site) }));
const stages = full ? fullStages : jobStages;

const models = {
  jev: `TypeSafe Jev${process.env.TEXT_MODEL ? ` + ${process.env.TEXT_MODEL} (field values)` : ""}`,
  "browser-use": process.env.DIMENSION_BROWSER_USE_MODEL ?? "gpt-4.1-mini",
};
models.hybrid = `accounts: browser-use (${models["browser-use"]}); jobs: jev (${models.jev}), browser-use if jev fails`;
/** Stages that create or verify accounts, as opposed to job applications (the Network JOB stage shares the id "network"). */
const isAccountStage = (stage) => stage.account === true;

// ---------------------------------------------------------------- MCP client

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const stderrTail = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: packDir,
  env: { ...process.env, DIMENSION_BROWSER_HEADLESS: opts.headed ? "false" : "true" },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => {
  stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  stderrTail.splice(0, Math.max(0, stderrTail.length - 40));
});
const client = new Client({ name: "dimension-browser-bench", version: "0.1.0" });
await client.connect(transport);

async function call(name, args, options) {
  const result = await client.callTool({ name, arguments: args }, undefined, options);
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text")?.text;
    const error = new Error(`${name} failed: ${result.structuredContent?.error ?? text ?? "unknown error"}`);
    error.structured = result.structuredContent;
    throw error;
  }
  return result.structuredContent;
}

// ---------------------------------------------------------------- run

const runs = [];
const startedAt = new Date();

/**
 * `stall` (hybrid's jev leg): give up early instead of waiting for the agent to
 * quit on its own - after `idleSeconds` without a step, or `waitSteps`
 * consecutive "wait" actions (jev repeating a wait means it sees no way on).
 */
async function runStage(agent, browserId, stage, label = `${agent}/${stage.id}`, stall = null) {
  if (stage.reset) await resetWorld();
  const run = { agent, stage: stage.id, success: false, seconds: 0, solvedSeconds: null, status: "error", stepCount: 0, usage: null, summary: "", error: null, reason: "", check: null };
  const t0 = performance.now();
  // The world is polled on every step so the report can show when the stage was actually achieved,
  // separately from when the agent declared itself done.
  const pollSolved = () => {
    if (run.solvedSeconds !== null) return;
    const at = (performance.now() - t0) / 1000;
    worldResults().then((r) => { if (run.solvedSeconds === null && stage.score(r).success) run.solvedSeconds = at; }).catch(() => {});
  };
  const take = (t) => Object.assign(run, { status: t.status, stepCount: t.stepCount, usage: t.usage, summary: t.summary, taskMs: t.elapsedMs });
  try {
    await call("browser_act", { browserId, action: { kind: "navigate", url: stage.start } });
    console.log(`[${label}] task started`);
    let lastStepAt = performance.now();
    let waits = 0;
    const progress = { onprogress: (p) => {
      console.log(`[${label}] ${p.progress}: ${p.message ?? ""}`);
      lastStepAt = performance.now();
      waits = /^wait\b/.test(p.message ?? "") ? waits + 1 : 0;
      pollSolved();
    }, timeout: 60_000 };
    const deadline = performance.now() + taskTimeoutMs;
    const credential = agent === "jev" && stage.task.includes(PASSWORD) ? { origin: base, mode: stage.account ? "signup" : "login" } : undefined;
    let taskRun = take(await call("browser_task", { browserId, agent, task: stage.task.replaceAll(PASSWORD, agent === "jev" ? "(filled by the browser)" : a.password), maxSteps, ...(credential ? { credential } : {}), waitSeconds: 3 }, progress));
    while (taskRun.status === "running") {
      if (performance.now() > deadline) {
        run.status = "timeout";
        throw new Error(`task exceeded ${taskTimeoutMs / 1000}s`);
      }
      // Stop as soon as the world counts the stage done: an agent that keeps
      // working after the site accepted the application is only burning time.
      if (stage.score(await worldResults()).success) {
        take(await call("browser_task_cancel", { browserId }));
        run.status = "done";
        break;
      }
      if (stall && (waits >= stall.waitSteps || performance.now() - lastStepAt > stall.idleSeconds * 1000)) {
        take(await call("browser_task_cancel", { browserId }));
        run.status = "stalled";
        console.log(`[${label}] stalled (${waits >= stall.waitSteps ? `${waits} waits in a row` : `no step for ${stall.idleSeconds}s`}); handing over`);
        break;
      }
      taskRun = take(await call("browser_task_wait", { browserId, waitSeconds: 3 }, progress));
    }
  } catch (error) {
    run.error = error.message;
    if (run.status !== "timeout") run.status = error.structured?.status ?? "error";
    console.error(`[${label}] ${error.message}`);
    await call("browser_task_cancel", { browserId }).catch(() => {});
  }
  run.seconds = (performance.now() - t0) / 1000;
  const check = stage.score(await worldResults());
  Object.assign(run, { check, success: check.success, reason: check.reason });
  if (run.success) run.solvedSeconds = Math.min(run.solvedSeconds ?? run.seconds, run.seconds);
  else run.solvedSeconds = null;
  console.log(`[${label}] ${run.status} in ${run.seconds.toFixed(1)}s, ${run.stepCount} steps -> ${run.success ? `PASS (achieved at ${run.solvedSeconds.toFixed(1)}s)` : `FAIL (${check.reason})`}`);
  return run;
}

for (const agent of agents) {
  console.log(`\n## ${agent}`);
  if (full) await resetWorld();
  let browserId = null;
  seedCredential(`bench-${agent}`);
  try {
    browserId = (await call("browser_open", { profile: `bench-${agent}`, engine: opts.engine, url: `${base}/` })).browserId;
  } catch (error) {
    console.error(`[bench] ${agent}: browser_open failed: ${error.message}`);
    for (const stage of stages) runs.push({ agent, stage: stage.id, success: false, seconds: 0, status: "error", error: error.message, reason: "browser_open failed", stepCount: 0, usage: null });
    continue;
  }
  for (const stage of stages) {
    if (agent !== "hybrid") {
      runs.push(await runStage(agent, browserId, stage));
      continue;
    }
    // Hybrid: each stage goes to the agent that does it best. Accounts need
    // multi-step judgment (browser-use); single forms need speed (jev), with
    // browser-use finishing whatever jev leaves undone. Time adds up honestly.
    // jev is handed off after 20 s without a step or two waits in a row; its
    // good runs take 2-4 s per step, so neither cuts off a working attempt.
    const account = isAccountStage(stage);
    const first = await runStage(account ? "browser-use" : "jev", browserId, stage, `hybrid/${stage.id}`, account ? null : { idleSeconds: 20, waitSteps: 2 });
    let run = first;
    if (!first.success && !isAccountStage(stage)) {
      const rescue = await runStage("browser-use", browserId, stage, `hybrid/${stage.id}:browser-use`);
      run = { ...rescue, seconds: first.seconds + rescue.seconds, stepCount: first.stepCount + rescue.stepCount,
        solvedSeconds: rescue.solvedSeconds === null ? null : first.seconds + rescue.solvedSeconds,
        usage: sumUsage(first.usage, rescue.usage), summary: `jev: ${first.reason}; then browser-use: ${rescue.summary}` };
    }
    runs.push({ ...run, agent: "hybrid", by: run === first ? first.agent : "jev→browser-use" });
  }
  await call("browser_close", { browserId }).catch((error) => console.error(`[bench] ${agent}: browser_close failed: ${error.message}`));
}

/**
 * The practice sites score the fixture password, so the bench profile holds it
 * as the browser's saved credential for the practice origin before the browser
 * opens (the profile lock is not held yet). Same root, in the same order, and
 * file the pack uses: DIMENSION_BROWSER_ROOT (src/server.ts), else
 * src/store.ts defaultRootDir; src/credentials.ts credentials.json.
 */
function seedCredential(profile) {
  const insoHome = process.env.INSO_HOME?.trim();
  const root = process.env.DIMENSION_BROWSER_ROOT || (insoHome ? join(insoHome, "browser") : join(homedir(), ".inso", "browser"));
  const dir = join(root, "profiles", profile);
  const file = join(dir, "credentials.json");
  let origins = {};
  try {
    origins = JSON.parse(readFileSync(file, "utf8")).origins ?? {};
  } catch {
    /* none saved yet */
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ version: 1, origins: { ...origins, [new URL(base).origin]: a.password } })}\n`, { mode: 0o600 });
}

function sumUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { modelCalls: a.modelCalls + b.modelCalls, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd == null && b.costUsd == null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0) };
}

await client.close();
sitesServer?.close();

// ---------------------------------------------------------------- report

const finishedAt = new Date();
console.log("\n| agent | passed | seconds | steps | model calls | tokens |\n| --- | ---: | ---: | ---: | ---: | ---: |");
for (const t of agents.map((x) => summarize(runs, x))) console.log(`| ${t.agent} | ${t.passed}/${t.stages} | ${t.seconds.toFixed(1)} | ${t.steps} | ${t.modelCalls} | ${t.tokens} |`);

const outDir = new URL("./results/", import.meta.url);
await mkdir(outDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const jsonFile = new URL(`${stamp}.json`, outDir);
const mdFile = new URL(`${stamp}.md`, outDir);
const raw = {
  scenario: opts.scenario, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), base, options: opts, models,
  applicant: full ? mailAddress : a.email, agents, stages: stages.map(({ id, account, start, task }) => ({ id, account: account === true, start, task })), runs,
  rawFile: `bench/results/${stamp}.json`,
};
await writeFile(jsonFile, JSON.stringify(raw, null, 2));
await writeFile(mdFile, renderReport(raw));
console.log(`\nReport: ${fileURLToPath(mdFile)}\nRaw results: ${fileURLToPath(jsonFile)}`);
if (runs.some((r) => r.error) && stderrTail.length) console.error(`\nMCP server stderr (tail):\n${stderrTail.join("\n")}`);
