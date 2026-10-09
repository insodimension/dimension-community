// Markdown report for a benchmark run: totals, per-stage detail, failures.
// Input is the same object run.mjs writes as raw JSON, so a report can be regenerated from any results file:
//   node bench/report.mjs bench/results/<ts>.json   (writes <ts>.md beside it)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const tokens = (u) => (u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0);
const secs = (s) => `${s.toFixed(1)} s`;
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "-");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

export function summarize(runs) {
  const sum = (f) => runs.reduce((n, r) => n + f(r), 0);
  const costs = runs.map((r) => r.usage?.costUsd).filter((c) => typeof c === "number");
  return {
    stages: runs.length,
    passed: runs.filter((r) => r.success).length,
    seconds: sum((r) => r.seconds),
    steps: sum((r) => r.stepCount ?? 0),
    modelCalls: sum((r) => r.usage?.modelCalls ?? 0),
    tokens: sum((r) => tokens(r.usage)),
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

export function renderReport(run) {
  const { scenario, startedAt, finishedAt, options, model, stages, runs } = run;
  const t = summarize(runs);
  const lines = [];
  lines.push(`# Browser agent benchmark: ${scenario} scenario`, "");
  lines.push(`- Started: ${startedAt}${finishedAt ? ` (finished ${finishedAt})` : ""}`);
  lines.push(`- Model: ${cell(model ?? "unknown")}`);
  lines.push(`- Stages: ${stages.length} (${stages.map((s) => s.id).join(", ")})`);
  lines.push(`- Engine: ${options.engine}${options.headed ? " (headed)" : " (headless)"}, max ${options["max-steps"]} steps and ${options.timeout} s per stage`);
  lines.push(`- Practice world: ${run.base}`);
  if (run.video) lines.push(`- Video: \`${run.video}\` (what the View showed, in real time, with the stage and run timers burned in)`);

  lines.push("", "## Totals", "", "| passed | accuracy | seconds | steps | model calls | tokens | cost USD |", "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(`| ${t.passed}/${t.stages} | ${pct(t.passed, t.stages)} | ${t.seconds.toFixed(1)} | ${t.steps} | ${t.modelCalls} | ${t.tokens} | ${t.costUsd === null ? "-" : t.costUsd.toFixed(4)} |`);

  lines.push("", "## Stages", "", "| stage | result | seconds | achieved at | steps | model calls | tokens | status |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const r of runs) {
    lines.push(`| ${r.stage} | ${r.success ? "pass" : "FAIL"} | ${r.seconds.toFixed(1)} | ${r.solvedSeconds == null ? "-" : r.solvedSeconds.toFixed(1)} | ${r.stepCount ?? 0} | ${r.usage?.modelCalls ?? "-"} | ${r.usage ? tokens(r.usage) : "-"} | ${r.status}${r.seeded ? ", then seeded" : ""} |`);
  }
  lines.push("", "_seconds_: wall time until the agent stopped (done, failed or timed out). _achieved at_: first moment the practice world recorded the stage as correct (polled after every agent step). _then seeded_: the agent failed an account stage, so the harness completed that account from the fixture and signed the browser in; the stage still counts as failed, and the stages after it measure their own task.");

  const failures = runs.filter((r) => !r.success);
  lines.push("", "## Failures", "");
  if (!failures.length) lines.push("None.");
  for (const r of failures) {
    lines.push(`- **${r.stage}** (${r.status}, ${secs(r.seconds)}): ${cell(r.reason || "no reason reported")}`);
    if (r.error) lines.push(`  - error: ${cell(r.error)}`);
    if (r.summary) lines.push(`  - agent summary: ${cell(r.summary)}`);
  }
  if (run.rawFile) lines.push("", `Raw results: \`${run.rawFile}\``);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node bench/report.mjs <results.json>");
    process.exit(2);
  }
  const out = file.replace(/\.json$/, ".md");
  writeFileSync(out, renderReport(JSON.parse(readFileSync(file, "utf8"))));
  console.log(out);
}
