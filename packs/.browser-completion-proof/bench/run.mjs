#!/usr/bin/env node
// Browser task-agent benchmark: drives the jev task agent through the practice world (bench/sites/server.mjs)
// via the pack's MCP server (app/server.mjs over stdio), scores every stage from /__results and writes a
// markdown report plus raw JSON to bench/results/. Its browser data (bench profiles, saved fixture password)
// lives in a directory it makes under .scratch/browser-bench/ and deletes when the run ends; it never uses
// ~/.inso or ~/.inso-dev.
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderReport, summarize } from "./report.mjs";
import { startRecorder } from "./record.mjs";

const USAGE = `Usage: node bench/run.mjs [options]

Runs the jev task agent against the local practice world and reports speed and accuracy per stage.

Scenarios (--scenario):
  jobs   One independent application per site; the world is reset before each site and the
         applicant uses the fixed example email. Sites: --sites (default acme,globex,initech,umbrella,hooli;
         also soylent,tyrell).
  full   ONE browser and a chain of tasks in a fresh world:
           mail     create an @mail.test account (fake "I'm not a robot" check)
           network  sign up on Network with that address and verify it from the inbox
           profile  complete the Network profile wizard
           <job>    apply to each of the ten jobs with the created address: acme, globex, initech,
                    umbrella, hooli, network (find 1 of 20 postings + Easy Apply), wayne (Apply with
                    Network consent popup), cyberdyne (confirm from inbox), soylent (4-page wizard with
                    resume), tyrell (form in an iframe). --sites narrows the jobs.

Options:
  --scenario <name>   jobs | full (default: jobs)
  --sites <list>      Comma-separated job sites (defaults above)
  --engine <name>     Browser engine for browser_open (default: chromium)
  --headed            Show the browser window (DIMENSION_BROWSER_HEADLESS=false)
  --port <n>          Practice world port; started in-process if not already running (default: 4777)
  --max-steps <n>     maxSteps passed to browser_task (default: 40)
  --timeout <sec>     Hard wall-clock limit per stage (default: 600)
  --root <dir>        Browser data directory to use instead of a fresh one; kept after the run (yours to
                      delete). The only way to run when DIMENSION_BROWSER_ROOT or INSO_HOME points into
                      ~/.inso or ~/.inso-dev.
  --record            Record a video (the View's live frames, with stage and run timers)
                      to bench/results/<timestamp>-jev.mp4; needs ffmpeg on PATH
  -h, --help          Show this help

Output: a scorecard on stdout, bench/results/<timestamp>.md (report) and <timestamp>.json (raw).
Browser data: every run makes its own directory under .scratch/browser-bench/ (gitignored), gives it to the
pack server as DIMENSION_BROWSER_ROOT and deletes it when the run ends. ~/.inso and ~/.inso-dev are never used.
Model keys come from the environment: jev needs TYPESAFE_API_KEY and TEXT_MODEL_API_KEY (TEXT_MODEL,
TEXT_MODEL_BASE_URL optional). browser_task is offered only where TYPESAFE_API_KEY is set, so a run without it stops at once.`;

const JOB_SITES = ["acme", "globex", "initech", "umbrella", "hooli", "network", "wayne", "cyberdyne", "soylent", "tyrell"];
const STANDALONE_SITES = ["acme", "globex", "initech", "umbrella", "hooli", "soylent", "tyrell"];
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

const { values: opts } = parseArgs({
  options: {
    scenario: { type: "string", default: "jobs" },
    sites: { type: "string" },
    engine: { type: "string", default: "chromium" },
    headed: { type: "boolean", default: false },
    port: { type: "string", default: "4777" },
    "max-steps": { type: "string", default: "40" },
    timeout: { type: "string", default: "600" },
    root: { type: "string" },
    record: { type: "boolean", default: false },
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

const AGENT = "jev";
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
if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.error("Refusing to start: browser_task is offered only where jev's key (TYPESAFE_API_KEY) is set, so this run would have no task tool to call.");
  process.exit(2);
}

// ---------------------------------------------------------------- browser data root

const repoRoot = resolve(packDir, "..", "..", "..");
const scratchRoot = join(repoRoot, ".scratch", "browser-bench");
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const realHomes = [".inso", ".inso-dev"].map((name) => real(join(homedir(), name)));
if (!opts.root) {
  const ambient = ["DIMENSION_BROWSER_ROOT", "INSO_HOME"].filter((name) => process.env[name]?.trim() && realHomes.some((home) => inside(real(process.env[name].trim()), home)));
  if (ambient.length) {
    console.error(`Refusing to start: ${ambient.join(" and ")} ${ambient.length === 1 ? "points" : "point"} into your real Inso data (~/.inso or ~/.inso-dev). The bench makes its own browser data and must not run beside it. Unset ${ambient.length === 1 ? "it" : "them"}, or pass --root <dir> to choose a bench directory yourself.`);
    process.exit(2);
  }
}
// Made here, so ours to delete: only a directory this run created is ever removed, and only under .scratch/browser-bench/.
const ownsRoot = !opts.root;
let browserRoot;
if (opts.root) {
  browserRoot = resolve(opts.root);
  mkdirSync(browserRoot, { recursive: true });
} else {
  mkdirSync(scratchRoot, { recursive: true });
  browserRoot = mkdtempSync(join(scratchRoot, "run-"));
}
function removeBrowserRoot() {
  if (!ownsRoot) return;
  if (browserRoot === scratchRoot || !inside(browserRoot, scratchRoot)) throw new Error(`refusing to delete ${browserRoot}: not a directory this run made`);
  rmSync(browserRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
// Also covers an uncaught error; Chrome can hold files for a moment after exit, hence the retries.
process.once("exit", () => {
  try {
    removeBrowserRoot();
  } catch (error) {
    console.error(`[bench] browser data ${browserRoot} was not deleted: ${error.message}`);
  }
});
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
// Task text names the password by this token, replaced in runStage. jev never
// receives it: the browser fills password fields from the credential it holds
// for the bench profile (seeded below with the fixture).
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
stages.forEach((stage, i) => { stage.n = i + 1; });

const model = `TypeSafe Jev${process.env.TEXT_MODEL ? ` + ${process.env.TEXT_MODEL} (field values)` : ""}`;
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
  env: { ...process.env, DIMENSION_BROWSER_ROOT: browserRoot, DIMENSION_BROWSER_HEADLESS: opts.headed ? "false" : "true" },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => {
  stderrTail.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  stderrTail.splice(0, Math.max(0, stderrTail.length - 40));
});
const client = new Client({ name: "dimension-browser-bench", version: "0.1.0" });
await client.connect(transport);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void client.close().catch(() => undefined).finally(() => process.exit(130)));
}

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

async function runStage(browserId, stage, rec = null) {
  const label = `${AGENT}/${stage.id}`;
  if (stage.reset) await resetWorld();
  const run = { stage: stage.id, success: false, seconds: 0, solvedSeconds: null, status: "error", stepCount: 0, usage: null, summary: "", error: null, reason: "", check: null };
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
    await call("browser_act", { browserId, actions: [{ kind: "navigate", url: stage.start }] });
    console.log(`[${label}] task started`);
    rec?.stage(`${stage.n}/${stages.length}  ${stage.account ? "account" : "job"} · ${stage.id}   [${AGENT}]`);
    // The step list every call returns is what the recording shows, not progress
    // notifications: a step that lands between two calls is never notified.
    let lastStepN = 0;
    const observe = (t) => {
      for (const step of t.steps ?? []) {
        if (step.n <= lastStepN) continue;
        lastStepN = step.n;
        rec?.step(`${step.n}. ${step.action}`);
      }
      return take(t);
    };
    const progress = { onprogress: (p) => {
      console.log(`[${label}] +${((performance.now() - t0) / 1000).toFixed(1)}s ${p.progress}: ${p.message ?? ""}`);
      pollSolved();
    }, timeout: 60_000 };
    const deadline = performance.now() + taskTimeoutMs;
    const credential = stage.task.includes(PASSWORD) ? { origin: base, mode: stage.account ? "signup" : "login" } : undefined;
    let taskRun = observe(await call("browser_task", { browserId, task: stage.task.replaceAll(PASSWORD, "(filled by the browser)"), maxSteps, ...(credential ? { credential } : {}), waitSeconds: 3 }, progress));
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
      taskRun = observe(await call("browser_task_wait", { browserId, waitSeconds: 3 }, progress));
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
  rec?.verdict(run.success ? `PASS  ${stage.id} in ${run.seconds.toFixed(1)} s` : `FAIL  ${stage.id}: ${check.reason}`);
  return run;
}

const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
const resultsDir = fileURLToPath(new URL("./results/", import.meta.url));
let video = null;

console.log(`\n## ${AGENT}`);
if (full) await resetWorld();
let browserId = null;
seedCredential(`bench-${AGENT}`);
try {
  browserId = (await call("browser_open", { profile: `bench-${AGENT}`, engine: opts.engine, url: `${base}/` })).browserId;
} catch (error) {
  console.error(`[bench] ${AGENT}: browser_open failed: ${error.message}`);
  for (const stage of stages) runs.push({ stage: stage.id, success: false, seconds: 0, status: "error", error: error.message, reason: "browser_open failed", stepCount: 0, usage: null });
}
if (browserId) {
  const rec = opts.record
    ? startRecorder({ call, browserId, dir: join(resultsDir, `${stamp}-${AGENT}-frames`), title: `${AGENT}  ·  ${model}` })
    : null;
  for (const stage of stages) {
    const run = await runStage(browserId, stage, rec);
    // A failed account stage still counts as failed, but the stages after it
    // must measure THEIR task, not inherit the failure: the harness repairs
    // the account from the fixture and signs this browser in (/__seed).
    if (isAccountStage(stage) && !run.success) {
      try {
        await call("browser_act", { browserId, actions: [{ kind: "navigate", url: `${base}/__seed?stage=${stage.id}` }] });
        run.seeded = (await worldResults()).seeded.includes(stage.id);
        if (run.seeded) console.log(`[${AGENT}/${stage.id}] repaired by the harness so later stages start fair`);
      } catch (error) {
        console.error(`[${AGENT}/${stage.id}] seed failed: ${error.message}`);
      }
    }
    runs.push(run);
  }
  if (rec) {
    const file = join(resultsDir, `${stamp}-${AGENT}.mp4`);
    try {
      if (await rec.finish(file)) {
        video = `bench/results/${stamp}-${AGENT}.mp4`;
        console.log(`[bench] ${AGENT}: video ${file}`);
      }
    } catch (error) {
      console.error(`[bench] ${AGENT}: video failed: ${error.message}`);
    }
  }
  await call("browser_close", { browserId }).catch((error) => console.error(`[bench] ${AGENT}: browser_close failed: ${error.message}`));
}

/**
 * The practice sites score the fixture password, so the bench profile holds it as the browser's saved credential for the practice origin
 * before the browser opens (the profile lock is not held yet). Written by the pack's own credentials module (bench/seed-credential.ts,
 * run with bun), never by hand: the store is sealed under the root's key, and what the profile already holds (this may be a --root used
 * before) is kept as it is.
 */
function seedCredential(profile) {
  const bun = typeof Bun === "undefined" ? "bun" : process.execPath;
  const seeded = spawnSync(bun, [fileURLToPath(new URL("./seed-credential.ts", import.meta.url))], {
    input: JSON.stringify({ root: browserRoot, profile, origin: new URL(base).origin, password: a.password }),
    encoding: "utf8",
    windowsHide: true,
  });
  if (seeded.status !== 0) {
    console.error(`[bench] could not save the practice password through the pack's credentials module (needs bun on PATH): ${seeded.error?.message ?? seeded.stderr}`);
    process.exit(2);
  }
}

await client.close();
removeBrowserRoot();
sitesServer?.close();

// ---------------------------------------------------------------- report

const finishedAt = new Date();
console.log("\n| passed | seconds | steps | model calls | tokens |\n| ---: | ---: | ---: | ---: | ---: |");
const total = summarize(runs);
console.log(`| ${total.passed}/${total.stages} | ${total.seconds.toFixed(1)} | ${total.steps} | ${total.modelCalls} | ${total.tokens} |`);

const outDir = new URL("./results/", import.meta.url);
await mkdir(outDir, { recursive: true });
const jsonFile = new URL(`${stamp}.json`, outDir);
const mdFile = new URL(`${stamp}.md`, outDir);
const raw = {
  scenario: opts.scenario, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), base, options: opts, model,
  applicant: full ? mailAddress : a.email, stages: stages.map(({ id, account, start, task }) => ({ id, account: account === true, start, task })), runs,
  rawFile: `bench/results/${stamp}.json`, video,
};
await writeFile(jsonFile, JSON.stringify(raw, null, 2));
await writeFile(mdFile, renderReport(raw));
console.log(`\nReport: ${fileURLToPath(mdFile)}\nRaw results: ${fileURLToPath(jsonFile)}`);
if (runs.some((r) => r.error) && stderrTail.length) console.error(`\nMCP server stderr (tail):\n${stderrTail.join("\n")}`);
