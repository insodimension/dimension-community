// Markdown report for a benchmark run: summary per agent, stage-by-stage comparison, per-agent detail, failures.
// Input is the same object run.mjs writes as raw JSON, so a report can be regenerated from any results file:
//   node bench/report.mjs bench/results/<ts>.json   (writes <ts>.md beside it)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const tokens = (u) => (u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0);
const secs = (s) => `${s.toFixed(1)} s`;
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "-");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

export function summarize(runs, agent) {
  const rs = runs.filter((r) => r.agent === agent);
  const sum = (f) => rs.reduce((n, r) => n + f(r), 0);
  const costs = rs.map((r) => r.usage?.costUsd).filter((c) => typeof c === "number");
  return {
    agent,
    stages: rs.length,
    passed: rs.filter((r) => r.success).length,
    seconds: sum((r) => r.seconds),
    steps: sum((r) => r.stepCount ?? 0),
    modelCalls: sum((r) => r.usage?.modelCalls ?? 0),
    tokens: sum((r) => tokens(r.usage)),
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}

export function renderReport(run) {
  const { scenario, startedAt, finishedAt, options, models, agents, stages, runs } = run;
  const totals = agents.map((a) => summarize(runs, a));
  const lines = [];
  lines.push(`# Browser agent benchmark: ${scenario} scenario`, "");
  lines.push(`- Started: ${startedAt}${finishedAt ? ` (finished ${finishedAt})` : ""}`);
  lines.push(`- Stages: ${stages.length} (${stages.map((s) => s.id).join(", ")})`);
  lines.push(`- Engine: ${options.engine}${options.headed ? " (headed)" : " (headless)"}, max ${options["max-steps"]} steps and ${options.timeout} s per stage`);
  lines.push(`- Practice world: ${run.base}`, "");

  lines.push("## Models", "", "| agent | model |", "| --- | --- |");
  for (const a of agents) lines.push(`| ${a} | ${cell(models[a] ?? "unknown")} |`);
  const videos = Object.entries(run.videos ?? {});
  if (videos.length) {
    lines.push("", "## Videos", "", "What the View showed, in real time, with the stage and run timers burned in.", "");
    for (const [agent, file] of videos) lines.push(`- **${agent}**: \`${file}\``);
  }

  lines.push("", "## Totals", "", "| agent | passed | accuracy | seconds | steps | model calls | tokens | cost USD |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const t of totals) {
    lines.push(`| ${t.agent} | ${t.passed}/${t.stages} | ${pct(t.passed, t.stages)} | ${t.seconds.toFixed(1)} | ${t.steps} | ${t.modelCalls} | ${t.tokens} | ${t.costUsd === null ? "-" : t.costUsd.toFixed(4)} |`);
  }
  if (totals.length) {
    const fastest = [...totals].sort((x, y) => x.seconds - y.seconds)[0];
    const accurate = [...totals].sort((x, y) => y.passed - x.passed || x.seconds - y.seconds)[0];
    lines.push("", `**Fastest agent:** ${fastest.agent} (${secs(fastest.seconds)} total, ${pct(fastest.passed, fastest.stages)} accurate).`);
    if (accurate.agent !== fastest.agent) lines.push(`**Most accurate:** ${accurate.agent} (${accurate.passed}/${accurate.stages}, ${secs(accurate.seconds)} total).`);
  }

  if (agents.length > 1) {
    lines.push("", "## Stage by stage", "", `| stage | ${agents.join(" | ")} |`, `| --- | ${agents.map(() => "---").join(" | ")} |`);
    // Stages are matched by position: two stages can share an id (the Network
    // account and the Network Jobs application are both "network").
    stages.forEach((s, i) => {
      const cells = agents.map((a) => {
        const r = runs.filter((x) => x.agent === a)[i];
        return r ? `${r.success ? "pass" : "FAIL"} ${secs(r.seconds)}${r.solvedSeconds == null ? "" : ` (achieved ${secs(r.solvedSeconds)})`}` : "-";
      });
      const isAccount = s.account ?? (["mail", "verify", "profile"].includes(s.id) || (s.id === "network" && !stages.slice(0, i).some((p) => p.id === "network")));
      lines.push(`| ${isAccount ? s.id : `${s.id} (job)`} | ${cells.join(" | ")} |`);
    });
  }

  for (const a of agents) {
    lines.push("", `## ${a}`, "", "| stage | result | seconds | achieved at | steps | model calls | tokens | status |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const r of runs.filter((x) => x.agent === a)) {
      lines.push(`| ${r.stage} | ${r.success ? "pass" : "FAIL"} | ${r.seconds.toFixed(1)} | ${r.solvedSeconds == null ? "-" : r.solvedSeconds.toFixed(1)} | ${r.stepCount ?? 0} | ${r.usage?.modelCalls ?? "-"} | ${r.usage ? tokens(r.usage) : "-"} | ${r.status}${r.seeded ? ", then seeded" : ""} |`);
    }
  }
  lines.push("", "_seconds_: wall time until the agent stopped (done, failed or timed out). _achieved at_: first moment the practice world recorded the stage as correct (polled after every agent step). _then seeded_: the agent failed an account stage, so the harness completed that account from the fixture and signed the browser in; the stage still counts as failed, and the stages after it measure their own task.");

  const failures = runs.filter((r) => !r.success);
  lines.push("", "## Failures", "");
  if (!failures.length) lines.push("None.");
  for (const r of failures) {
    lines.push(`- **${r.agent} / ${r.stage}** (${r.status}, ${secs(r.seconds)}): ${cell(r.reason || "no reason reported")}`);
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
