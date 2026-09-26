#!/usr/bin/env node
// Practice world for the browser benchmark. No dependencies, no external network, deterministic.
//   node bench/sites/server.mjs --port 4777
// Mail (/mail): create an @mail.test account (fake "I'm not a robot" check), inbox, message view.
// Network (/network, LinkedIn-like): sign up with the mail.test address, verify through a link in the
//   inbox, profile wizard, a 20-posting job board with search filters and Easy Apply, and an OAuth-style
//   "Apply with Network" consent popup used by Wayne.
// Ten jobs, one Frontend Engineer application each, of rising difficulty:
//   acme (one form) · globex (two steps) · initech (radio/checkbox/consent + validation) · umbrella (cookie
//   wall + confirm page) · hooli (autocomplete + cover letter) · network (find 1 of 20 postings, Easy Apply
//   modal) · wayne (Apply with Network consent popup) · cyberdyne (confirm the application from the inbox)
//   · soylent (four-page wizard with pasted resume) · tyrell (form inside an iframe).
// Every account, profile and application is checked against bench/applicant.json. Applications must use the
// email address the applicant created on Mail (ada@example.test only while no Mail account exists).
//   GET /__results  -> stages (mailAccount, networkAccount, profile) and per-job correctness with reasons
//   POST /__reset   -> forget every account, session, mail and submission
//   GET /__seed?stage=mail|network|verify|profile -> harness only: create whatever the applicant's
//        accounts lack up to that stage (fixture values), sign this browser in to both, redirect to /.
//        Lets later stages start fair after an agent failed an account stage; listed in /__results.seeded.
import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const applicant = JSON.parse(readFileSync(new URL("../applicant.json", import.meta.url), "utf8"));

// ---------------------------------------------------------------- expectations

const MAIL_DOMAIN = "mail.test";
const fullName = `${applicant.firstName} ${applicant.lastName}`;
const expectedMailAddress = `${applicant.mailUsername}@${MAIL_DOMAIN}`;
const experienceBucket = (y) => (y <= 1 ? "0-1" : y <= 4 ? "2-4" : y <= 9 ? "5-9" : "10+");

const CITIES = [
  { id: "c-2207", name: "Riverside, CA" },
  { id: "c-3141", name: "Riverton, OR" },
  { id: "c-4410", name: "River Falls, WI" },
  { id: "c-5023", name: "Rivertown, GA" },
  { id: "c-6118", name: "Rockport, ME" },
  { id: "c-7031", name: "Portland, OR" },
  { id: "c-7032", name: "Salem, OR" },
  { id: "c-8120", name: "Springfield, IL" },
  { id: "c-9001", name: "Brookline, MA" },
];
const applicantCity = CITIES.find((c) => c.name.toLowerCase().startsWith(applicant.city.toLowerCase() + ","));
if (!applicantCity) throw new Error(`applicant city ${applicant.city} is not in the city list`);

const JOBS = [
  { key: "fe", title: "Frontend Engineer", team: "Web Platform", location: "Remote (US)" },
  { key: "be", title: "Backend Engineer", team: "Core Services", location: "Remote (US)" },
  { key: "pd", title: "Product Designer", team: "Design", location: "Hybrid" },
  { key: "sre", title: "Site Reliability Engineer", team: "Infrastructure", location: "On-site" },
];

// The email every application must carry: the address the applicant created on Mail.
const CREATED_EMAIL = Symbol("created mail address");

// kinds: text (case/whitespace-insensitive), email, phone (digits), url, exact, set, letter, prefix,
// secret (byte-exact), grant (a live Network OAuth code issued to this site)
const SITES = {
  acme: {
    name: "Acme Robotics", color: "#c0392b", font: "Georgia, serif",
    ids: { fe: "1042", be: "1043", pd: "1051", sre: "1060" },
    tagline: "Building friendly robots since 1987.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", CREATED_EMAIL],
      phone: ["phone", applicant.phone],
      linkedin: ["url", applicant.linkedin],
    },
  },
  globex: {
    name: "Globex Corporation", color: "#1f6feb", font: "Helvetica, Arial, sans-serif",
    ids: { fe: "FE-2201", be: "BE-2202", pd: "PD-2210", sre: "SR-2230" },
    tagline: "Tomorrow's infrastructure, today.",
    expect: {
      firstName: ["text", applicant.firstName],
      lastName: ["text", applicant.lastName],
      email: ["email", CREATED_EMAIL],
      phone: ["phone", applicant.phone],
      experience: ["exact", experienceBucket(applicant.yearsExperience)],
      city: ["text", applicant.city],
    },
  },
  initech: {
    name: "Initech", color: "#6b4f9e", font: "Verdana, sans-serif",
    ids: { fe: "frontend-engineer", be: "backend-engineer", pd: "product-designer", sre: "sre" },
    tagline: "Software for the modern enterprise.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", CREATED_EMAIL],
      phone: ["phone", applicant.phone],
      workAuth: ["exact", applicant.workAuthorized ? "yes" : "no"],
      skills: ["set", applicant.skills],
      consent: ["exact", "on"],
    },
  },
  umbrella: {
    name: "Umbrella Health", color: "#a0522d", font: "'Trebuchet MS', sans-serif",
    ids: { fe: "r-88213", be: "r-88214", pd: "r-88230", sre: "r-88241" },
    tagline: "Caring for people, powered by software.",
    expect: {
      firstName: ["text", applicant.firstName],
      lastName: ["text", applicant.lastName],
      email: ["email", CREATED_EMAIL],
      phone: ["phone", applicant.phone],
      linkedin: ["url", applicant.linkedin],
      yearsExperience: ["exact", String(applicant.yearsExperience)],
    },
  },
  hooli: {
    name: "Hooli", color: "#0f9d58", font: "system-ui, sans-serif",
    ids: { fe: "fe", be: "be", pd: "pd", sre: "sre" },
    tagline: "Making the world a better place.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", CREATED_EMAIL],
      city: ["prefix", applicant.city],
      cityId: ["exact", applicantCity.id],
      coverLetter: ["letter", applicant.coverLetter],
    },
  },
  wayne: {
    name: "Wayne Enterprises", color: "#1c1c1c", font: "'Palatino Linotype', Palatino, serif",
    ids: { fe: "WE-7781", be: "WE-7782", pd: "WE-7790", sre: "WE-7795" },
    tagline: "Investing in Gotham's future.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", CREATED_EMAIL],
      headline: ["text", applicant.headline],
      phone: ["phone", applicant.phone],
      networkCode: ["grant", "wayne"],
    },
  },
  cyberdyne: {
    name: "Cyberdyne Systems", color: "#8a1c1c", font: "'Courier New', monospace",
    ids: { fe: "cd-310", be: "cd-311", pd: "cd-320", sre: "cd-330" },
    tagline: "Neural net processors for a safer world.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", CREATED_EMAIL],
      phone: ["phone", applicant.phone],
      yearsExperience: ["exact", String(applicant.yearsExperience)],
    },
  },
  soylent: {
    name: "Soylent Foods", color: "#2e7d32", font: "'Segoe UI', sans-serif",
    ids: { fe: "sg-fe-19", be: "sg-be-20", pd: "sg-pd-21", sre: "sg-sre-22" },
    tagline: "Feeding tomorrow.",
    expect: {
      firstName: ["text", applicant.firstName],
      lastName: ["text", applicant.lastName],
      email: ["email", CREATED_EMAIL],
      phone: ["phone", applicant.phone],
      currentTitle: ["text", applicant.headline],
      yearsExperience: ["exact", String(applicant.yearsExperience)],
      resume: ["letter", applicant.resume],
    },
  },
  tyrell: {
    name: "Tyrell Corporation", color: "#b8860b", font: "Futura, 'Century Gothic', sans-serif",
    ids: { fe: "nexus-fe", be: "nexus-be", pd: "nexus-pd", sre: "nexus-sre" },
    tagline: "More human than human.",
    expect: {
      fullName: ["text", fullName],
      email: ["email", CREATED_EMAIL],
      phone: ["phone", applicant.phone],
      location: ["exact", applicantCity.id],
      linkedin: ["url", applicant.linkedin],
    },
  },
};

// Network job board: 20 postings; the target is the full-time, Remote, Senior Frontend Engineer at Stark Industries.
const NET_TARGET = "nj-4113";
const NET_JOBS = [
  ["nj-4101", "Senior Frontend Engineer", "Stark Industries", "Malibu, CA", "On-site", "Senior", "Full-time", true],
  ["nj-4102", "Frontend Engineer", "Stark Industries", "United States", "Remote", "Mid-level", "Full-time", true],
  ["nj-4103", "Senior Frontend Engineer", "Stark Labs", "United States", "Remote", "Senior", "Full-time", true],
  ["nj-4104", "Senior Backend Engineer", "Stark Industries", "United States", "Remote", "Senior", "Full-time", true],
  ["nj-4105", "Product Designer", "Pied Piper", "Palo Alto, CA", "Hybrid", "Mid-level", "Full-time", true],
  ["nj-4106", "Staff Frontend Engineer", "Stark Industries", "United States", "Remote", "Staff", "Full-time", false],
  ["nj-4107", "Senior Frontend Engineer", "Oscorp", "United States", "Remote", "Senior", "Full-time", true],
  ["nj-4108", "Data Analyst", "Stark Industries", "New York, NY", "Hybrid", "Entry level", "Full-time", true],
  ["nj-4109", "Frontend Developer", "Massive Dynamic", "Boston, MA", "Hybrid", "Mid-level", "Full-time", true],
  ["nj-4110", "Senior Frontend Engineer", "Stark Industries", "New York, NY", "Hybrid", "Senior", "Full-time", true],
  ["nj-4111", "Engineering Manager, Web", "Stark Industries", "United States", "Remote", "Director", "Full-time", false],
  ["nj-4112", "Senior UI Engineer", "Aperture Science", "United States", "Remote", "Senior", "Full-time", true],
  ["nj-4113", "Senior Frontend Engineer", "Stark Industries", "United States", "Remote", "Senior", "Full-time", true],
  ["nj-4114", "Mobile Engineer (React Native)", "Stark Industries", "United States", "Remote", "Senior", "Full-time", true],
  ["nj-4115", "Senior Frontend Engineer", "Initrode", "United States", "Remote", "Senior", "Full-time", true],
  ["nj-4116", "QA Engineer", "Stark Industries", "Malibu, CA", "On-site", "Mid-level", "Full-time", true],
  ["nj-4117", "Senior Frontend Engineer", "Stark Industries", "United States", "Remote", "Senior", "Contract", true],
  ["nj-4118", "Junior Frontend Engineer", "Stark Industries", "United States", "Remote", "Entry level", "Full-time", true],
  ["nj-4119", "Full Stack Engineer", "Wayne Enterprises", "Gotham, NJ", "On-site", "Senior", "Full-time", false],
  ["nj-4120", "Senior Frontend Engineer", "Stark Industries", "United States", "Remote", "Senior", "Internship", true],
].map(([id, title, company, location, workplace, level, type, easy], i) => ({ id, title, company, location, workplace, level, type, easy, posted: `${i + 1}d ago` }));

const EXPECT = {
  ...Object.fromEntries(Object.entries(SITES).map(([k, s]) => [k, s.expect])),
  network: {
    email: ["email", CREATED_EMAIL],
    phone: ["phone", applicant.phone],
    yearsExperience: ["exact", String(applicant.yearsExperience)],
    workAuth: ["exact", applicant.workAuthorized ? "yes" : "no"],
  },
};
const JOB_SITES = ["acme", "globex", "initech", "umbrella", "hooli", "network", "wayne", "cyberdyne", "soylent", "tyrell"];
const targetJob = (site) => (site === "network" ? NET_TARGET : SITES[site].ids.fe);

const norm = (s) => String(s ?? "").normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const url = (s) => norm(s).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

function matches(kind, expected, got) {
  switch (kind) {
    case "text": case "email": case "exact": return norm(got) === norm(expected);
    case "prefix": return norm(got).startsWith(norm(expected));
    case "phone": { const e = digits(expected), g = digits(got); return g === e || (g.length >= 10 && e.endsWith(g)); }
    case "url": return url(got) === url(expected);
    case "letter": return norm(got).replace(/[.!\s]+$/, "") === norm(expected).replace(/[.!\s]+$/, "");
    case "set": return [...new Set(got.map(norm))].sort().join("|") === [...new Set(expected.map(norm))].sort().join("|");
    case "secret": return String(got) === String(expected);
    case "grant": return state.grants.get(got)?.client === expected;
    default: throw new Error(`unknown kind ${kind}`);
  }
}

// Compares one record against a spec; `get(field, kind)` reads the submitted value.
function compare(spec, get) {
  const missing = [];
  const wrong = [];
  const fields = {};
  for (const [field, [kind, rawExpected]] of Object.entries(spec)) {
    const expected = rawExpected === CREATED_EMAIL ? expectedEmail() : rawExpected;
    const got = get(field, kind);
    fields[field] = kind === "secret" ? (got ? "***" : got) : got;
    const empty = kind === "set" ? !got?.length : !String(got ?? "").trim();
    if (empty) missing.push(field);
    else if (!matches(kind, expected, got)) wrong.push({ field, expected: kind === "secret" ? "***" : kind === "grant" ? `a Network grant for ${expected}` : expected, got: kind === "secret" ? "***" : got });
  }
  return { fields, missing, wrong };
}

function checkSubmission(site, jobId, params) {
  const { fields, missing, wrong } = compare(EXPECT[site], (field, kind) => (kind === "set" ? params.getAll(field) : params.get(field)));
  if (jobId !== targetJob(site)) wrong.unshift({ field: "job", expected: targetJob(site), got: jobId });
  return { jobId, fields, missing, wrong };
}

// ---------------------------------------------------------------- world state

let BASE = "http://127.0.0.1:4777";
let seq = 0;
const newId = (prefix) => `${prefix}${(++seq).toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0")}`;

function freshState() {
  return {
    mail: new Map(), // address -> { address, firstName, lastName, birthday, password, createdAt, messages[] }
    mailOrder: [], // addresses in creation order
    bounced: [], // mail sent to addresses that do not exist
    mailSessions: new Map(), // sid -> address
    net: new Map(), // email -> { email, firstName, lastName, password, verified, profile, completed }
    netOrder: [],
    netSessions: new Map(), // sid -> email
    verifyTokens: new Map(), // token -> email
    grants: new Map(), // code -> { client, email, name, headline, job }
    drafts: new Map(), // soylent draft id -> { jobId, values }
    confirmTokens: new Map(), // token -> cyberdyne submission
    submissions: Object.fromEntries(JOB_SITES.map((s) => [s, []])),
    seeded: [], // account stages the harness completed because the agent did not
  };
}

const SEED_STAGES = ["mail", "network", "verify", "profile"];
/**
 * Harness only (GET /__seed): the world the next stage expects once `stage` has succeeded, built from
 * the fixture wherever the agent left it missing or wrong, plus fresh Mail and Network sessions for
 * the browser that asked. Every stage it had to repair is recorded in state.seeded.
 */
function seed(stage) {
  const upTo = SEED_STAGES.indexOf(stage);
  if (upTo < 0) return [];
  const note = (s) => { if (!state.seeded.includes(s)) state.seeded.push(s); };
  const address = `${applicant.mailUsername}@${MAIL_DOMAIN}`;
  if (!mailStage().success) {
    const box = state.mail.get(address);
    state.mail.set(address, { createdAt: new Date().toISOString(), messages: [], ...box, address, firstName: applicant.firstName, lastName: applicant.lastName, birthday: applicant.birthday, password: applicant.password });
    // The applicant's address is the last Mail account created (expectedEmail).
    state.mailOrder = [...state.mailOrder.filter((a) => a !== address), address];
    note("mail");
  }
  const cookies = [startSession("mail_sid", "/mail", state.mailSessions, address)];
  if (upTo < 1) return cookies;
  let account = state.net.get(address);
  const net = networkStage();
  if (!account) {
    account = { email: address, firstName: applicant.firstName, lastName: applicant.lastName, password: applicant.password, verified: false, profile: {}, completed: false, createdAt: new Date().toISOString() };
    state.net.set(address, account);
    sendVerification(account);
    note("network");
  } else if (networkAccount() !== account || net.missing?.length || net.wrong?.length) {
    Object.assign(account, { firstName: applicant.firstName, lastName: applicant.lastName, password: applicant.password });
    note("network");
  }
  state.netOrder = [...state.netOrder.filter((e) => e !== address), address];
  if (upTo >= 2 && !account.verified) {
    account.verified = true;
    note("verify");
  }
  if (upTo >= 3 && !profileStage().success) {
    Object.assign(account.profile, { headline: applicant.headline, location: applicantCity.id, yearsExperience: String(applicant.yearsExperience), skills: [...applicant.skills] });
    account.completed = true;
    note("profile");
  }
  cookies.push(startSession("net_sid", "/network", state.netSessions, address));
  return cookies;
}
let state = freshState();

// The last Mail account created is the applicant's address; before that the legacy example address.
const expectedEmail = () => state.mailOrder.at(-1) ?? applicant.email;

function sendMail(to, from, subject, html) {
  const box = state.mail.get(norm(to));
  const message = { id: newId("m"), from, to: norm(to), subject, html, at: new Date().toISOString(), read: false };
  if (!box) {
    state.bounced.push({ to: norm(to), from, subject, at: message.at });
    console.log(`[bench-sites] mail bounced: "${subject}" -> ${to} (no such mailbox)`);
    return false;
  }
  box.messages.push(message);
  console.log(`[bench-sites] mail delivered: "${subject}" -> ${to}`);
  return true;
}

function record(site, jobId, params, { extraWrong = [], confirmed } = {}) {
  const check = { at: new Date().toISOString(), ...checkSubmission(site, jobId, params) };
  check.wrong.push(...extraWrong);
  check.fieldsCorrect = check.missing.length === 0 && check.wrong.length === 0;
  if (confirmed !== undefined) check.confirmed = confirmed;
  state.submissions[site].push(check);
  const status = check.fieldsCorrect ? "correct" : `missing=[${check.missing}] wrong=[${check.wrong.map((w) => w.field)}]`;
  console.log(`[bench-sites] ${site} submission #${state.submissions[site].length} job=${jobId} ${status}${confirmed === false ? " (awaiting email confirmation)" : ""}`);
  return check;
}

// ---------------------------------------------------------------- results

function reasonOf(entry) {
  if (!entry) return "not submitted";
  const parts = [];
  if (entry.confirmed === false) parts.push("application submitted but never confirmed from the inbox");
  if (entry.missing.length) parts.push(`missing ${entry.missing.join(", ")}`);
  for (const w of entry.wrong) parts.push(`${w.field}: expected ${JSON.stringify(w.expected)}, got ${JSON.stringify(w.got)}`);
  return parts.join("; ") || "ok";
}

function jobResult(site, base) {
  const list = state.submissions[site];
  // A confirmed (or confirmation-free) submission outranks a later unconfirmed one.
  const entry = list.findLast((s) => s.confirmed !== false) ?? list.at(-1);
  const success = Boolean(entry?.fieldsCorrect && entry.confirmed !== false);
  return {
    url: site === "network" ? `${base}/network/jobs` : `${base}/${site}`,
    submitted: list.length,
    fieldsCorrect: Boolean(entry?.fieldsCorrect),
    confirmed: entry?.confirmed ?? null,
    success,
    reason: success ? "ok" : reasonOf(entry),
    missing: entry ? entry.missing : Object.keys(EXPECT[site]),
    wrong: entry ? entry.wrong : [],
    lastSubmittedAt: entry?.at ?? null,
    last: entry ? { jobId: entry.jobId, fields: entry.fields } : null,
  };
}

function stageResult(record, spec, extra = {}) {
  const { fields, missing, wrong } = compare(spec, (field) => record[field]);
  const reasons = [...missing.map((f) => `missing ${f}`), ...wrong.map((w) => `${w.field}: expected ${JSON.stringify(w.expected)}, got ${JSON.stringify(w.got)}`)];
  return { fields, missing, wrong, reasons, ...extra };
}

function mailStage() {
  const created = [...state.mailOrder];
  const account = state.mail.get(expectedMailAddress);
  if (!account) {
    return { success: false, expected: expectedMailAddress, address: created.at(-1) ?? null, created, reason: created.length ? `created ${created.join(", ")} instead of ${expectedMailAddress}` : "no mail account created" };
  }
  const r = stageResult(account, {
    firstName: ["text", applicant.firstName],
    lastName: ["text", applicant.lastName],
    birthday: ["exact", applicant.birthday],
    password: ["secret", applicant.password],
  });
  const success = r.missing.length === 0 && r.wrong.length === 0;
  return { success, expected: expectedMailAddress, address: account.address, created, messages: account.messages.length, missing: r.missing, wrong: r.wrong, reason: success ? "ok" : r.reasons.join("; ") };
}

const networkAccount = () => state.net.get(expectedEmail()) ?? state.net.get(state.netOrder.at(-1));

function networkStage() {
  const account = networkAccount();
  if (!account) return { success: false, created: false, verified: false, email: null, emailMatchesMail: false, reason: "no Network account created" };
  const r = stageResult(account, {
    email: ["email", CREATED_EMAIL],
    firstName: ["text", applicant.firstName],
    lastName: ["text", applicant.lastName],
    password: ["secret", applicant.password],
  });
  const reasons = [...r.reasons];
  if (!account.verified) reasons.unshift("email not verified");
  const success = account.verified && r.missing.length === 0 && r.wrong.length === 0;
  return { success, created: true, verified: account.verified, email: account.email, emailMatchesMail: account.email === expectedEmail(), missing: r.missing, wrong: r.wrong, reason: success ? "ok" : reasons.join("; ") };
}

function profileStage() {
  const account = networkAccount();
  if (!account) return { success: false, completeness: 0, completed: false, reason: "no Network account" };
  const spec = {
    headline: ["text", applicant.headline],
    location: ["exact", applicantCity.id],
    yearsExperience: ["exact", String(applicant.yearsExperience)],
    skills: ["set", applicant.skills],
  };
  const r = stageResult(account.profile, spec);
  const correct = Object.keys(spec).length - r.missing.length - r.wrong.length;
  const completeness = Math.round((correct / Object.keys(spec).length) * 100);
  const reasons = [...r.reasons];
  if (!account.completed) reasons.unshift("profile wizard not finished");
  const success = account.completed && completeness === 100;
  return { success, completeness, completed: account.completed, fields: r.fields, missing: r.missing, wrong: r.wrong, reason: success ? "ok" : reasons.join("; ") };
}

function results(base) {
  return {
    applicant: expectedEmail(),
    expectedMailAddress,
    stages: { mailAccount: mailStage(), networkAccount: networkStage(), profile: profileStage() },
    seeded: state.seeded,
    jobs: Object.fromEntries(JOB_SITES.map((s) => [s, jobResult(s, base)])),
    mail: {
      accounts: [...state.mailOrder],
      inbox: Object.fromEntries([...state.mail.values()].map((b) => [b.address, b.messages.map((m) => ({ from: m.from, subject: m.subject, read: m.read }))])),
      bounced: state.bounced,
    },
  };
}

// ---------------------------------------------------------------- html

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function shell({ brand, home, color, font, tagline = "", title, body, script = "", right = "", after = "", footer }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} | ${esc(brand)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font-family:${font};color:#222;background:#f6f6f4}
header{background:${color};color:#fff;padding:14px 28px;display:flex;align-items:baseline;gap:16px}
header a{color:#fff;text-decoration:none}
header .brand{font-weight:bold;font-size:20px}
header span{opacity:.85;font-size:13px}
header nav{margin-left:auto;display:flex;gap:16px;font-size:14px}
main{max-width:760px;margin:28px auto;background:#fff;padding:24px 32px;border-radius:6px;box-shadow:0 1px 4px #0002}
h1{margin-top:0}
.job{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee;padding:12px 0;gap:12px}
.job small{color:#666}
label{display:block;margin:14px 0 4px;font-weight:600}
label.sub{font-weight:normal;font-size:12px;color:#555;margin-top:0}
input[type=text],input[type=email],input[type=tel],input[type=url],input[type=number],input[type=password],select,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #bbb;border-radius:4px;font:inherit}
.inline label{display:inline;font-weight:normal;margin:0 14px 0 4px}
.row{display:flex;gap:12px}.row>*{flex:1}
.btn{background:${color};color:#fff;border:0;padding:10px 20px;border-radius:4px;font:inherit;font-weight:bold;cursor:pointer;text-decoration:none;display:inline-block;margin-top:18px}
.btn.secondary{background:#888}
.btn.small{padding:6px 12px;margin-top:0;font-size:13px}
.error{color:#b00020;font-size:13px;margin-top:4px}
.errors{background:#fde8ea;border:1px solid #f5b5bd;color:#b00020;padding:10px 14px;border-radius:4px}
.notice{background:#e8f0fe;border:1px solid #aac4f5;padding:10px 14px;border-radius:4px}
.ok{background:#e6f4ea;border:1px solid #9fd3ad;padding:10px 14px;border-radius:4px}
.hint{font-size:12px;color:#666;margin-top:4px}
.hidden{display:none}
.suffix{display:flex;align-items:center;gap:6px}.suffix span{color:#555}
.badge{display:inline-block;background:#eef3f8;color:#0a66c2;border-radius:10px;padding:1px 8px;font-size:12px;font-weight:600}
.chip{display:inline-flex;align-items:center;gap:6px;background:#eef3f8;border-radius:14px;padding:4px 10px;margin:4px 6px 0 0}
.chip button{border:0;background:none;cursor:pointer;font-size:16px;line-height:1}
.steps{display:flex;gap:8px;margin-bottom:12px;font-size:13px;color:#666}.steps .on{color:#000;font-weight:bold}
table.list{width:100%;border-collapse:collapse}table.list td{padding:8px;border-bottom:1px solid #eee}
tr.unread td{font-weight:bold}
.modal{position:fixed;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:50}
.modal.hidden{display:none}
.modal-box{background:#fff;width:560px;max-width:94vw;max-height:90vh;overflow:auto;border-radius:8px;padding:0 24px 20px}
.modal-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee}
.modal-head button{border:0;background:none;font-size:24px;cursor:pointer}
.progress{height:6px;background:#eee;border-radius:3px;margin:12px 0}.progress div{height:6px;background:${color};border-radius:3px}
footer{text-align:center;color:#888;font-size:12px;margin:24px}
</style></head><body>
<header><a class="brand" href="${home}">${esc(brand)}</a><span>${esc(tagline)}</span>${right ? `<nav>${right}</nav>` : ""}</header>
<main>${body}</main>
<footer>${footer ?? `&copy; ${esc(brand)} &mdash; fictional, used for browser-agent practice.`}</footer>
${after}
${script ? `<script>${script}</script>` : ""}
</body></html>`;
}

function page(siteKey, title, body, { script = "", overlay = false } = {}) {
  const s = SITES[siteKey];
  return shell({ brand: `${s.name} Careers`, home: `/${siteKey}`, color: s.color, font: s.font, tagline: s.tagline, title, body, script, after: overlay ? cookieOverlay() : "", footer: `&copy; ${esc(s.name)} &mdash; a fictional company used for browser-agent practice.` });
}

function listing(site) {
  const s = SITES[site];
  const rows = JOBS.map((j) => `<div class="job"><div><a href="/${site}/jobs/${s.ids[j.key]}"><strong>${esc(j.title)}</strong></a><br><small>${esc(j.team)} &middot; ${esc(j.location)}</small></div><a class="btn secondary" href="/${site}/jobs/${s.ids[j.key]}">View role</a></div>`).join("");
  return `<h1>Open positions</h1><p>Join ${esc(s.name)}. We are hiring across ${JOBS.length} teams.</p>${rows}`;
}

function detail(site, job) {
  const s = SITES[site];
  const cta = { hooli: "Quick apply", wayne: "Apply now", soylent: "Start application" }[site] ?? "Apply for this job";
  return `<p><a href="/${site}">&larr; All jobs</a></p><h1>${esc(job.title)}</h1><p><small>${esc(job.team)} &middot; ${esc(job.location)} &middot; Req ${esc(s.ids[job.key])}</small></p>
<h3>About the role</h3><p>You will work with a small, senior team shipping ${esc(job.team.toLowerCase())} work used by millions of fictional customers.</p>
<h3>You have</h3><ul><li>3+ years of relevant experience</li><li>Care for quality and accessibility</li><li>Clear written communication</li></ul>
<a class="btn" href="/${site}/jobs/${s.ids[job.key]}/apply">${cta}</a>`;
}

function formHeader(site, job) {
  return `<p><a href="/${site}/jobs/${SITES[site].ids[job.key]}">&larr; Back to job</a></p><h1>Apply: ${esc(job.title)}</h1>`;
}

// (1) Acme: one simple form.
function acmeForm(action, job) {
  return `${formHeader("acme", job)}<form method="post" action="${action}">
<label for="fullName">Full name</label><input type="text" id="fullName" name="fullName" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="phone">Phone</label><input type="tel" id="phone" name="phone" required>
<label for="linkedin">LinkedIn profile</label><input type="url" id="linkedin" name="linkedin">
<button class="btn" type="submit">Submit application</button></form>`;
}

// (2) Globex: two steps in one form, Next button, select dropdown.
function globexForm(action, job) {
  const body = `${formHeader("globex", job)}<p id="stepLabel">Step 1 of 2: About you</p><form method="post" action="${action}" id="app">
<fieldset id="step1" style="border:0;padding:0">
<label for="firstName">First name</label><input type="text" id="firstName" name="firstName" required>
<label for="lastName">Last name</label><input type="text" id="lastName" name="lastName" required>
<label for="email">Email address</label><input type="email" id="email" name="email" required>
<button class="btn" type="button" id="next">Next</button></fieldset>
<fieldset id="step2" class="hidden" style="border:0;padding:0">
<label for="phone">Mobile phone</label><input type="tel" id="phone" name="phone" required disabled>
<label for="experience">Years of professional experience</label><select id="experience" name="experience" required disabled>
<option value="">Select...</option><option value="0-1">0-1 years</option><option value="2-4">2-4 years</option><option value="5-9">5-9 years</option><option value="10+">10+ years</option></select>
<label for="city">Current city</label><input type="text" id="city" name="city" required disabled>
<label for="referral">Referral code (optional)</label><input type="text" id="referral" name="referral" disabled>
<button class="btn secondary" type="button" id="back">Back</button> <button class="btn" type="submit">Submit application</button></fieldset></form>`;
  const script = `
const s1=document.getElementById('step1'),s2=document.getElementById('step2'),label=document.getElementById('stepLabel');
document.getElementById('next').onclick=()=>{for(const el of s1.querySelectorAll('input')){if(!el.reportValidity())return;}
s1.classList.add('hidden');s2.classList.remove('hidden');s2.querySelectorAll('input,select').forEach(e=>e.disabled=false);
for(const el of s1.querySelectorAll('input')){const h=document.createElement('input');h.type='hidden';h.name=el.name;h.value=el.value;h.dataset.copy='1';s2.appendChild(h);}
s1.querySelectorAll('input').forEach(e=>e.disabled=true);label.textContent='Step 2 of 2: Experience';document.getElementById('phone').focus();};
document.getElementById('back').onclick=()=>{s2.querySelectorAll('[data-copy]').forEach(e=>e.remove());s1.querySelectorAll('input').forEach(e=>e.disabled=false);
s2.classList.add('hidden');s1.classList.remove('hidden');label.textContent='Step 1 of 2: About you';};`;
  return { body, script };
}

// (3) Initech: radio, checkboxes, required consent, client-side validation errors.
function initechForm(action, job) {
  const skills = ["JavaScript", "TypeScript", "React", "Python", "Go", "Rust"];
  const body = `${formHeader("initech", job)}<div id="summary" class="errors hidden" role="alert"></div><form method="post" action="${action}" id="app" novalidate>
<label for="fullName">Full name *</label><input type="text" id="fullName" name="fullName"><div class="error" data-for="fullName"></div>
<label for="email">Email *</label><input type="text" id="email" name="email"><div class="error" data-for="email"></div>
<label for="phone">Phone number *</label><input type="text" id="phone" name="phone" placeholder="(555) 555-5555"><div class="error" data-for="phone"></div>
<label>Are you legally authorized to work in the US? *</label><div class="inline">
<input type="radio" id="wa-yes" name="workAuth" value="yes"><label for="wa-yes">Yes</label>
<input type="radio" id="wa-no" name="workAuth" value="no"><label for="wa-no">No</label></div><div class="error" data-for="workAuth"></div>
<label>Skills (select all that apply) *</label><div class="inline">
${skills.map((k) => `<input type="checkbox" id="sk-${k}" name="skills" value="${k}"><label for="sk-${k}">${k}</label>`).join("\n")}</div><div class="error" data-for="skills"></div>
<div class="inline" style="margin-top:18px"><input type="checkbox" id="consent" name="consent"><label for="consent">I consent to Initech storing my data for recruiting purposes. *</label></div><div class="error" data-for="consent"></div>
<button class="btn" type="submit">Submit application</button></form>`;
  const script = `
const f=document.getElementById('app'),sum=document.getElementById('summary');
f.addEventListener('submit',(ev)=>{const errs={};const v=(n)=>f.elements[n].value.trim();
if(!v('fullName'))errs.fullName='Full name is required.';
if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v('email')))errs.email='Enter a valid email address.';
if(v('phone').replace(/\\D/g,'').length<10)errs.phone='Phone number must have at least 10 digits.';
if(!f.querySelector('input[name=workAuth]:checked'))errs.workAuth='Please answer the work authorization question.';
if(!f.querySelector('input[name=skills]:checked'))errs.skills='Select at least one skill.';
if(!f.elements.consent.checked)errs.consent='You must consent to data processing to apply.';
document.querySelectorAll('.error').forEach(e=>e.textContent=errs[e.dataset.for]||'');
const n=Object.keys(errs).length;if(n){ev.preventDefault();sum.textContent='Please fix '+n+' error'+(n>1?'s':'')+' below.';sum.classList.remove('hidden');window.scrollTo(0,0);}});`;
  return { body, script };
}

// (4) Umbrella: cookie overlay first, then form, then an "are you sure" confirm page.
function cookieOverlay() {
  return `<div id="cookie-overlay" style="position:fixed;inset:0;background:#000a;z-index:1000;display:flex;align-items:flex-end;justify-content:center">
<div style="background:#fff;max-width:720px;width:100%;padding:22px 28px;border-radius:8px 8px 0 0;font-family:sans-serif">
<h2 style="margin-top:0">We value your privacy</h2><p>We use cookies to improve your experience and analyze traffic. You must choose an option to continue.</p>
<button class="btn secondary" type="button" onclick="umbrellaConsent('essential')">Essential only</button>
<button class="btn" type="button" onclick="umbrellaConsent('all')">Accept all cookies</button></div></div>
<script>function umbrellaConsent(v){document.cookie='umbrella_consent='+v+'.${consentEpoch}; path=/umbrella';document.getElementById('cookie-overlay').remove();}</script>`;
}

function umbrellaForm(action, job) {
  return `${formHeader("umbrella", job)}<form method="post" action="${action}">
<label for="firstName">Legal first name</label><input type="text" id="firstName" name="firstName" required>
<label for="lastName">Legal last name</label><input type="text" id="lastName" name="lastName" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="phone">Phone</label><input type="tel" id="phone" name="phone" required>
<label for="linkedin">LinkedIn URL</label><input type="url" id="linkedin" name="linkedin" required>
<label for="yearsExperience">Total years of experience</label><input type="number" id="yearsExperience" name="yearsExperience" min="0" max="60" required>
<button class="btn" type="submit">Review application</button></form>`;
}

function umbrellaConfirm(confirmAction, editHref, params) {
  const fields = Object.keys(SITES.umbrella.expect);
  const rows = fields.map((f) => `<tr><th style="text-align:left;padding:4px 16px 4px 0">${esc(f)}</th><td>${esc(params.get(f))}</td></tr>`).join("");
  const hidden = fields.map((f) => `<input type="hidden" name="${esc(f)}" value="${esc(params.get(f))}">`).join("");
  return `<h1>Are you sure?</h1><p>Please review your application. It has <strong>not</strong> been submitted yet.</p><table>${rows}</table>
<form method="post" action="${confirmAction}">${hidden}<a class="btn secondary" href="${editHref}">Go back and edit</a> <button class="btn" type="submit">Yes, submit my application</button></form>`;
}

// (5) Hooli: login-free quick apply with autocomplete city and cover letter textarea.
function hooliForm(action, job) {
  const body = `${formHeader("hooli", job)}<p>No account needed. Quick apply takes about a minute.</p><div id="summary" class="errors hidden" role="alert"></div>
<form method="post" action="${action}" id="app">
<label for="fullName">Your name</label><input type="text" id="fullName" name="fullName" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="city">City</label><div style="position:relative"><input type="text" id="city" name="city" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="city-list" autocomplete="off" placeholder="Start typing and choose from the list" required>
<ul id="city-list" role="listbox" class="hidden" style="position:absolute;left:0;right:0;top:100%;margin:0;padding:0;list-style:none;background:#fff;border:1px solid #bbb;z-index:10"></ul></div>
<input type="hidden" id="cityId" name="cityId">
<label for="coverLetter">Cover letter</label><textarea id="coverLetter" name="coverLetter" rows="6" maxlength="1000" required></textarea><div id="count" style="font-size:12px;color:#666">0 / 1000</div>
<button class="btn" type="submit">Send application</button></form>`;
  const script = `
const city=document.getElementById('city'),list=document.getElementById('city-list'),cityId=document.getElementById('cityId'),sum=document.getElementById('summary');
let items=[],active=-1,timer;
function render(){list.innerHTML='';items.forEach((c,i)=>{const li=document.createElement('li');li.role='option';li.id='city-opt-'+i;li.textContent=c.name;li.dataset.id=c.id;
li.style.cssText='padding:8px;cursor:pointer;'+(i===active?'background:#e6f4ea':'');li.onmousedown=(e)=>{e.preventDefault();choose(i);};list.appendChild(li);});
const open=items.length>0;list.classList.toggle('hidden',!open);city.setAttribute('aria-expanded',String(open));}
function choose(i){city.value=items[i].name;cityId.value=items[i].id;items=[];active=-1;render();}
city.addEventListener('input',()=>{cityId.value='';clearTimeout(timer);const q=city.value.trim();if(q.length<2){items=[];render();return;}
timer=setTimeout(async()=>{const r=await fetch('/hooli/api/cities?q='+encodeURIComponent(q));items=await r.json();active=items.length?0:-1;render();},250);});
city.addEventListener('keydown',(e)=>{if(!items.length)return;if(e.key==='ArrowDown'){active=(active+1)%items.length;render();e.preventDefault();}
else if(e.key==='ArrowUp'){active=(active-1+items.length)%items.length;render();e.preventDefault();}
else if(e.key==='Enter'||e.key==='Tab'){if(active>=0){choose(active);if(e.key==='Enter')e.preventDefault();}}else if(e.key==='Escape'){items=[];render();}});
city.addEventListener('blur',()=>setTimeout(()=>{items=[];render();},150));
const cl=document.getElementById('coverLetter'),count=document.getElementById('count');cl.addEventListener('input',()=>count.textContent=cl.value.length+' / 1000');
document.getElementById('app').addEventListener('submit',(e)=>{if(!cityId.value){e.preventDefault();sum.textContent='Please choose your city from the suggestions list.';sum.classList.remove('hidden');city.focus();}});`;
  return { body, script };
}

// (7) Wayne: no manual form, only "Apply with Network" (consent popup, code comes back to this page).
function wayneStart(jobId, job, error = "") {
  const authorize = `/network/oauth/authorize?client_id=wayne&job=${encodeURIComponent(jobId)}`;
  const body = `${formHeader("wayne", job)}${error ? `<div class="errors" role="alert">${esc(error)}</div>` : ""}
<p>Wayne Enterprises accepts applications through your <strong>Network</strong> profile. We import your name, email and headline; you add the rest.</p>
<button class="btn" type="button" id="nw">Apply with Network</button>
<p id="popup-note" class="notice hidden">A Network window opened for you to approve access. Finish there &mdash; or <a href="${authorize}">continue in this tab</a>.</p>`;
  const script = `document.getElementById('nw').onclick=()=>{const w=window.open(${JSON.stringify(authorize)},'network-oauth','popup,width=560,height=700');
if(!w){location.href=${JSON.stringify(authorize)};return;}document.getElementById('popup-note').classList.remove('hidden');};`;
  return { body, script };
}

function wayneForm(action, job, code, grant) {
  return `${formHeader("wayne", job)}<p class="ok">Imported from Network. Check the details and add what is missing.</p><form method="post" action="${action}">
<input type="hidden" name="networkCode" value="${esc(code)}">
<label for="fullName">Full name</label><input type="text" id="fullName" name="fullName" value="${esc(grant.name)}" readonly>
<label for="email">Email</label><input type="email" id="email" name="email" value="${esc(grant.email)}" readonly>
<label for="headline">Professional headline</label><input type="text" id="headline" name="headline" value="${esc(grant.headline)}" required>
<label for="phone">Phone</label><input type="tel" id="phone" name="phone" required>
<label for="motivation">Why Wayne Enterprises? (one or two sentences)</label><textarea id="motivation" name="motivation" rows="3" required></textarea>
<button class="btn" type="submit">Submit application</button></form>`;
}

function wayneDone(target) {
  return `<!doctype html><title>Returning to Wayne Enterprises</title><p>Returning to Wayne Enterprises&hellip; <a href="${esc(target)}">Continue</a></p>
<script>const t=${JSON.stringify(target)};try{if(window.opener&&!window.opener.closed){window.opener.location.href=t;window.close();}else location.replace(t);}catch(e){location.replace(t);}</script>`;
}

// (8) Cyberdyne: plain form, but the application only counts once confirmed from the inbox.
function cyberdyneForm(action, job) {
  return `${formHeader("cyberdyne", job)}<form method="post" action="${action}">
<label for="fullName">Full name</label><input type="text" id="fullName" name="fullName" required>
<label for="email">Email</label><input type="email" id="email" name="email" required>
<label for="phone">Phone</label><input type="tel" id="phone" name="phone" required>
<label for="yearsExperience">Years of experience</label><input type="number" id="yearsExperience" name="yearsExperience" min="0" max="60" required>
<button class="btn" type="submit">Submit application</button></form>`;
}

// (9) Soylent: server-side four-page wizard with a pasted resume.
const SOYLENT_STEPS = [
  { key: "contact", label: "Contact" },
  { key: "experience", label: "Experience" },
  { key: "resume", label: "Resume" },
  { key: "review", label: "Review" },
];
const SOYLENT_LABELS = { firstName: "First name", lastName: "Last name", email: "Email", phone: "Phone", currentTitle: "Current job title", yearsExperience: "Years of experience", resume: "Resume" };

function soylentStep(jobId, job, draftId, stepKey, values, errors = {}) {
  const idx = SOYLENT_STEPS.findIndex((s) => s.key === stepKey);
  const base = `/soylent/jobs/${jobId}/apply/${draftId}`;
  const err = (k) => (errors[k] ? `<div class="error">${esc(errors[k])}</div>` : "");
  const input = (name, type = "text") => `<label for="${name}">${SOYLENT_LABELS[name]}</label><input type="${type}" id="${name}" name="${name}" value="${esc(values[name])}">${err(name)}`;
  const stepper = `<div class="steps">${SOYLENT_STEPS.map((s, i) => `<span class="${i === idx ? "on" : ""}">${i + 1}. ${s.label}</span>`).join("<span>&rsaquo;</span>")}</div>`;
  let inner = "";
  if (stepKey === "contact") inner = `${input("firstName")}${input("lastName")}${input("email", "email")}${input("phone", "tel")}`;
  if (stepKey === "experience") {
    const years = Array.from({ length: 21 }, (_, y) => `<option value="${y}"${String(values.yearsExperience) === String(y) ? " selected" : ""}>${y === 20 ? "20+ years" : `${y} year${y === 1 ? "" : "s"}`}</option>`).join("");
    inner = `${input("currentTitle")}<label for="yearsExperience">${SOYLENT_LABELS.yearsExperience}</label><select id="yearsExperience" name="yearsExperience"><option value="">Choose...</option>${years}</select>${err("yearsExperience")}`;
  }
  if (stepKey === "resume") {
    inner = `<p>We do not accept file uploads. Paste the plain text of your resume below.</p><label for="resume">Resume</label><textarea id="resume" name="resume" rows="10" maxlength="4000">${esc(values.resume)}</textarea>${err("resume")}<div class="hint">At least 150 characters.</div>`;
  }
  if (stepKey === "review") {
    const rows = Object.entries(SOYLENT_LABELS).map(([k, l]) => `<tr><td style="width:180px;color:#555">${l}</td><td>${esc(values[k])}</td></tr>`).join("");
    inner = `<p>Please review. Your application is <strong>not</strong> submitted until you press Submit.</p><table class="list">${rows}</table><p><a href="${base}/contact">Edit contact</a> &middot; <a href="${base}/experience">Edit experience</a> &middot; <a href="${base}/resume">Edit resume</a></p>`;
  }
  const back = idx > 0 ? `<a class="btn secondary" href="${base}/${SOYLENT_STEPS[idx - 1].key}">Back</a> ` : "";
  const next = stepKey === "review" ? "Submit application" : "Save and continue";
  return `${formHeader("soylent", job)}${stepper}${Object.keys(errors).length ? `<div class="errors" role="alert">Please correct the errors below.</div>` : ""}
<h2>Step ${idx + 1} of ${SOYLENT_STEPS.length}: ${SOYLENT_STEPS[idx].label}</h2><form method="post" action="${base}/${stepKey}" novalidate>${inner}<div>${back}<button class="btn" type="submit">${next}</button></div></form>`;
}

function soylentValidate(stepKey, params) {
  const errors = {};
  const values = {};
  const keys = { contact: ["firstName", "lastName", "email", "phone"], experience: ["currentTitle", "yearsExperience"], resume: ["resume"] }[stepKey] ?? [];
  for (const k of keys) {
    values[k] = (params.get(k) ?? "").trim();
    if (!values[k]) errors[k] = `${SOYLENT_LABELS[k]} is required.`;
  }
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = "Enter a valid email address.";
  if (values.phone && digits(values.phone).length < 10) errors.phone = "Phone number must have at least 10 digits.";
  if (values.resume && values.resume.length < 150) errors.resume = "Your resume looks too short. Paste the full text (at least 150 characters).";
  return { values, errors };
}

// (10) Tyrell: the application form lives in an iframe served by a third-party ATS.
function tyrellHost(jobId, job) {
  return `${formHeader("tyrell", job)}<p>Applications are handled by our partner <strong>Greenhire</strong>. Complete the form below.</p>
<iframe src="/tyrell/embed/${esc(jobId)}" title="Greenhire application form" style="width:100%;height:820px;border:1px solid #ccc;border-radius:4px;background:#fff"></iframe>`;
}

function tyrellEmbed(jobId, job, done = false) {
  const inner = done
    ? `<h2>Thanks! Your application was received.</h2><p>Tyrell Corporation will review it and contact you by email.</p>`
    : `<h2>${esc(job.title)} &mdash; Tyrell Corporation</h2><form method="post" action="/tyrell/embed/${esc(jobId)}">
<label for="gh-name">Full name *</label><input type="text" id="gh-name" name="fullName" required>
<label for="gh-email">Email *</label><input type="email" id="gh-email" name="email" required>
<label for="gh-phone">Phone *</label><input type="tel" id="gh-phone" name="phone" required>
<label for="gh-location">Location *</label><select id="gh-location" name="location" required><option value="">Select your city</option>${CITIES.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
<label for="gh-linkedin">LinkedIn profile *</label><input type="url" id="gh-linkedin" name="linkedin" required>
<label for="gh-source">How did you hear about us? *</label><select id="gh-source" name="source" required><option value="">Select...</option><option>Network</option><option>Friend or colleague</option><option>Job board</option><option>Other</option></select>
<button type="submit">Submit application</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Greenhire</title><style>
body{font-family:Arial,sans-serif;margin:0;padding:16px 20px;color:#1a1a1a}label{display:block;margin:12px 0 4px;font-size:14px;font-weight:bold}
input,select{width:100%;box-sizing:border-box;padding:7px;border:1px solid #9aa;border-radius:3px;font:inherit}
button{margin-top:18px;background:#23a26d;color:#fff;border:0;padding:10px 18px;border-radius:3px;font-weight:bold;cursor:pointer}
.gh{font-size:11px;color:#777;margin-top:20px}</style></head><body>${inner}<p class="gh">Powered by Greenhire ATS</p></body></html>`;
}

function thanks(site, extra = "") {
  const ref = `${site.toUpperCase()}-${String(Date.now()).slice(-6)}`;
  return `<h1>Application received</h1><p>Thank you for applying. Your reference number is <strong>${ref}</strong>.</p>${extra}<p>We review every application and will be in touch by email.</p><p><a href="/${site}">Back to all jobs</a></p>`;
}

// ---------------------------------------------------------------- Mail

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function mailPage(title, body, { user, script = "" } = {}) {
  const right = user ? `<span>${esc(user.address)}</span><a href="/mail/inbox">Inbox</a><a href="/mail/logout">Sign out</a>` : `<a href="/mail/login">Sign in</a><a href="/mail/signup">Create account</a>`;
  return shell({ brand: "Mail", home: "/mail", color: "#d93025", font: "Arial, Helvetica, sans-serif", tagline: "Free email at mail.test", title, body, script, right });
}

function mailSignupForm(v = {}, errors = {}) {
  const err = (k) => (errors[k] ? `<div class="error">${esc(errors[k])}</div>` : "");
  const val = (k) => esc(v[k] ?? "");
  const body = `<h1>Create your Mail account</h1><p>One free account with an @${MAIL_DOMAIN} address.</p>
${Object.keys(errors).length ? `<div class="errors" role="alert">Please fix the highlighted fields.</div>` : ""}
<form method="post" action="/mail/signup" id="signup" novalidate>
<div class="row"><div><label for="firstName">First name</label><input type="text" id="firstName" name="firstName" value="${val("firstName")}">${err("firstName")}</div>
<div><label for="lastName">Last name</label><input type="text" id="lastName" name="lastName" value="${val("lastName")}">${err("lastName")}</div></div>
<label>Birthday</label><div class="row">
<div><label class="sub" for="birthMonth">Month</label><select id="birthMonth" name="birthMonth"><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i + 1}"${String(v.birthMonth) === String(i + 1) ? " selected" : ""}>${m}</option>`).join("")}</select></div>
<div><label class="sub" for="birthDay">Day</label><input type="text" inputmode="numeric" id="birthDay" name="birthDay" value="${val("birthDay")}" placeholder="DD"></div>
<div><label class="sub" for="birthYear">Year</label><input type="text" inputmode="numeric" id="birthYear" name="birthYear" value="${val("birthYear")}" placeholder="YYYY"></div></div>${err("birthday")}
<label for="username">Choose your Mail address</label><div class="suffix"><input type="text" id="username" name="username" value="${val("username")}" autocomplete="off"><span>@${MAIL_DOMAIN}</span></div>
<div class="hint">You can use lowercase letters, numbers and periods.</div>${err("username")}
<label for="password">Password</label><input type="password" id="password" name="password">${err("password")}
<label for="confirm">Confirm password</label><input type="password" id="confirm" name="confirm">${err("confirm")}
<div class="hint">Use 8 or more characters with a mix of letters and numbers.</div>
<div style="display:flex;align-items:center;gap:12px;border:1px solid #ccc;border-radius:4px;padding:12px 14px;margin-top:18px;width:300px;background:#f9f9f9">
<div id="robot" role="checkbox" aria-checked="false" aria-label="I'm not a robot" tabindex="0" style="width:26px;height:26px;border:2px solid #999;border-radius:3px;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;color:#0f9d58"></div>
<span id="robotLabel" style="cursor:pointer">I'm not a robot</span><input type="hidden" name="robot" id="robotToken"></div>${err("robot")}
<button class="btn" type="submit">Create account</button></form><p>Already have an account? <a href="/mail/login">Sign in</a></p>`;
  const script = `
const r=document.getElementById('robot'),t=document.getElementById('robotToken');
function tick(){if(r.getAttribute('aria-checked')==='true'||r.dataset.busy)return;r.dataset.busy='1';r.setAttribute('aria-busy','true');r.textContent='\\u2026';
setTimeout(()=>{r.removeAttribute('aria-busy');r.setAttribute('aria-checked','true');r.textContent='\\u2713';r.style.borderColor='#0f9d58';t.value='human-'+Date.now().toString(36);delete r.dataset.busy;},900);}
r.addEventListener('click',tick);document.getElementById('robotLabel').addEventListener('click',tick);
r.addEventListener('keydown',(e)=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();tick();}});`;
  return mailPage("Create account", body, { script });
}

function mailSignupValidate(p) {
  const v = Object.fromEntries(["firstName", "lastName", "birthMonth", "birthDay", "birthYear", "username"].map((k) => [k, (p.get(k) ?? "").trim()]));
  v.username = v.username.toLowerCase().replace(new RegExp(`@${MAIL_DOMAIN.replace(".", "\\.")}$`), "");
  const password = p.get("password") ?? "";
  const errors = {};
  if (!v.firstName) errors.firstName = "Enter first name.";
  if (!v.lastName) errors.lastName = "Enter last name.";
  const [y, m, d] = [Number(v.birthYear), Number(v.birthMonth), Number(v.birthDay)];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (!v.birthMonth || !v.birthDay || !v.birthYear) errors.birthday = "Enter your complete birthday.";
  else if (!(y >= 1900 && y <= 2012) || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) errors.birthday = "Enter a valid date. You must be at least 13.";
  if (!v.username) errors.username = "Choose a Mail address.";
  else if (!/^[a-z0-9](?:[a-z0-9.]{1,28})[a-z0-9]$/.test(v.username) || v.username.includes("..")) errors.username = "Sorry, only letters (a-z), numbers (0-9) and periods (.) are allowed; 3-30 characters.";
  else if (state.mail.has(`${v.username}@${MAIL_DOMAIN}`) || ["admin", "postmaster", "ada"].includes(v.username)) errors.username = "That address is taken. Try another.";
  if (password.length < 8 || !/[a-z]/i.test(password) || !/\d/.test(password)) errors.password = "Use 8 or more characters with a mix of letters and numbers.";
  else if (password !== (p.get("confirm") ?? "")) errors.confirm = "Those passwords didn't match. Try again.";
  if (!/^human-[a-z0-9]+$/.test(p.get("robot") ?? "")) errors.robot = "Please confirm you're not a robot.";
  const birthday = errors.birthday ? "" : `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { v, errors, account: { address: `${v.username}@${MAIL_DOMAIN}`, firstName: v.firstName, lastName: v.lastName, birthday, password } };
}

function mailLogin(error = "", address = "") {
  return mailPage("Sign in", `<h1>Sign in to Mail</h1>${error ? `<div class="errors" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/mail/login"><label for="address">Email address</label><input type="email" id="address" name="address" value="${esc(address)}">
<label for="password">Password</label><input type="password" id="password" name="password"><button class="btn" type="submit">Sign in</button></form>
<p>New to Mail? <a class="btn secondary small" href="/mail/signup">Create account</a></p>`);
}

function mailInbox(user) {
  const rows = [...user.messages].reverse().map((m) => `<tr class="${m.read ? "" : "unread"}"><td style="width:220px">${esc(m.from)}</td><td><a href="/mail/m/${m.id}">${esc(m.subject)}</a></td><td style="width:80px;color:#666;font-size:12px">${m.at.slice(11, 16)}</td></tr>`).join("");
  return mailPage("Inbox", `<h1>Inbox</h1><p>${user.messages.filter((m) => !m.read).length} unread &middot; <a href="/mail/inbox">Refresh</a></p>${rows ? `<table class="list">${rows}</table>` : "<p>No messages yet.</p>"}`, { user });
}

function mailMessage(user, m) {
  return mailPage(m.subject, `<p><a href="/mail/inbox">&larr; Back to inbox</a></p><h1>${esc(m.subject)}</h1>
<p style="color:#555;font-size:13px">From: ${esc(m.from)}<br>To: ${esc(m.to)}<br>${esc(m.at.replace("T", " ").slice(0, 16))}</p><hr><div class="message-body">${m.html}</div>`, { user });
}

async function handleMail(req, res, parts) {
  const [, , section, id] = parts;
  const user = sessionUser(req, "mail_sid", state.mailSessions, state.mail);
  if (!section) return redirect(res, user ? "/mail/inbox" : "/mail/login");
  if (section === "signup" && req.method === "GET") return send(res, 200, mailSignupForm());
  if (section === "signup" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    const { v, errors, account } = mailSignupValidate(p);
    if (Object.keys(errors).length) return send(res, 200, mailSignupForm(v, errors));
    state.mail.set(account.address, { ...account, createdAt: new Date().toISOString(), messages: [] });
    state.mailOrder.push(account.address);
    console.log(`[bench-sites] mail account created: ${account.address}`);
    sendMail(account.address, "Mail Team <team@mail.test>", `Welcome to Mail, ${account.firstName}`, `<p>Hi ${esc(account.firstName)},</p><p>Your new address is <strong>${esc(account.address)}</strong>. Messages sent to it appear in this inbox.</p><p>&mdash; The Mail Team</p>`);
    return redirect(res, "/mail/inbox", startSession("mail_sid", "/mail", state.mailSessions, account.address));
  }
  if (section === "login" && req.method === "GET") return send(res, 200, mailLogin());
  if (section === "login" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    const address = norm(p.get("address"));
    const account = state.mail.get(address);
    if (!account || account.password !== p.get("password")) return send(res, 200, mailLogin("Wrong email or password.", p.get("address") ?? ""));
    return redirect(res, "/mail/inbox", startSession("mail_sid", "/mail", state.mailSessions, account.address));
  }
  if (section === "logout") return redirect(res, "/mail/login", "mail_sid=; Path=/mail; Max-Age=0");
  if (!user) return redirect(res, "/mail/login");
  if (section === "inbox") return send(res, 200, mailInbox(user));
  if (section === "m") {
    const m = user.messages.find((x) => x.id === id);
    if (!m) return send(res, 404, mailPage("Not found", "<h1>Message not found</h1>", { user }));
    m.read = true;
    return send(res, 200, mailMessage(user, m));
  }
  return send(res, 404, mailPage("Not found", "<h1>Page not found</h1>", { user }));
}

// ---------------------------------------------------------------- Network

function netPage(title, body, { user, script = "", after = "" } = {}) {
  const right = user
    ? `<a href="/network">Home</a><a href="/network/jobs">Jobs</a><a href="/network/profile">Me (${esc(user.firstName)})</a><a href="/network/logout">Sign out</a>`
    : `<a href="/network/jobs">Jobs</a><a href="/network/login">Sign in</a><a href="/network/signup">Join now</a>`;
  return shell({ brand: "Network", home: "/network", color: "#0a66c2", font: "-apple-system, 'Segoe UI', Roboto, sans-serif", tagline: "Your professional community", title, body, script, right, after });
}

const profileStrength = (u) => Math.round(([u.profile.headline, u.profile.location, u.profile.yearsExperience, u.profile.skills?.length].filter(Boolean).length / 4) * 100);

function sendVerification(user) {
  const token = newId("v");
  state.verifyTokens.set(token, user.email);
  const link = `${BASE}/network/verify?token=${token}`;
  sendMail(user.email, "Network <security@network.test>", "Confirm your email address", `<p>Hi ${esc(user.firstName)},</p><p>Confirm your email address to finish joining Network.</p>
<p><a href="${link}" style="background:#0a66c2;color:#fff;padding:10px 18px;border-radius:18px;text-decoration:none;font-weight:bold">Confirm your email</a></p><p style="font-size:12px;color:#666">Or paste this link into your browser: ${link}</p>`);
}

function netSignup(v = {}, error = "") {
  return netPage("Join Network", `<h1>Make the most of your professional life</h1>${error ? `<div class="errors" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/network/signup" novalidate>
<label for="email">Email</label><input type="email" id="email" name="email" value="${esc(v.email)}">
<label for="password">Password (8+ characters)</label><input type="password" id="password" name="password">
<div class="row"><div><label for="firstName">First name</label><input type="text" id="firstName" name="firstName" value="${esc(v.firstName)}"></div>
<div><label for="lastName">Last name</label><input type="text" id="lastName" name="lastName" value="${esc(v.lastName)}"></div></div>
<p class="hint">By clicking Agree &amp; Join you agree to the (fictional) User Agreement.</p><button class="btn" type="submit">Agree &amp; Join</button></form>
<p>Already on Network? <a href="/network/login">Sign in</a></p>`);
}

function netLogin(next = "", error = "", email = "") {
  return netPage("Sign in", `<h1>Sign in</h1><p>Stay updated on your professional world.</p>${error ? `<div class="errors" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/network/login"><input type="hidden" name="next" value="${esc(next)}">
<label for="email">Email</label><input type="email" id="email" name="email" value="${esc(email)}">
<label for="password">Password</label><input type="password" id="password" name="password"><button class="btn" type="submit">Sign in</button></form>
<p>New to Network? <a href="/network/signup">Join now</a></p>`);
}

function netVerifyWall(user, sent = false) {
  return netPage("Verify your email", `<h1>Verify your email to continue</h1>${sent ? `<p class="ok">We sent a new link.</p>` : ""}
<p class="notice">We sent a verification link to <strong>${esc(user.email)}</strong>. Open that inbox, open the email from Network and click <em>Confirm your email</em>.</p>
<form method="post" action="/network/resend"><button class="btn secondary" type="submit">Resend email</button></form>`, { user });
}

function netHome(user) {
  const strength = profileStrength(user);
  const verify = user.verified ? `<p class="ok">Email verified: ${esc(user.email)}</p>` : `<p class="notice">Verify your email: we sent a link to <strong>${esc(user.email)}</strong>. <a href="/network/check-email">Details</a></p>`;
  return netPage("Home", `<h1>Welcome, ${esc(user.firstName)}!</h1>${verify}
<h3>Profile strength: ${strength}%</h3><div class="progress"><div style="width:${strength}%"></div></div>
${user.completed ? `<p><a href="/network/profile">View your profile</a></p>` : `<p><a class="btn" href="/network/onboarding">Complete your profile</a></p>`}
<p><a href="/network/jobs">Find jobs &rarr;</a></p>`, { user });
}

const ONBOARD_STEPS = ["about", "experience", "skills"];

function netOnboarding(user, step, error = "") {
  const idx = ONBOARD_STEPS.indexOf(step);
  const pr = user.profile;
  const stepper = `<div class="steps">${["About you", "Experience", "Skills"].map((l, i) => `<span class="${i === idx ? "on" : ""}">${i + 1}. ${l}</span>`).join("<span>&rsaquo;</span>")}</div>`;
  let inner = "";
  let script = "";
  if (step === "about") {
    inner = `<label for="headline">Headline</label><input type="text" id="headline" name="headline" value="${esc(pr.headline)}" placeholder="e.g. Software Engineer">
<label for="location">Location</label><select id="location" name="location"><option value="">Select a city</option>${CITIES.map((c) => `<option value="${c.id}"${pr.location === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`;
  }
  if (step === "experience") {
    inner = `<label for="yearsExperience">Years of professional experience</label><input type="number" id="yearsExperience" name="yearsExperience" min="0" max="60" value="${esc(pr.yearsExperience)}">
<div class="inline" style="margin-top:14px"><input type="checkbox" id="openToWork" name="openToWork"${pr.openToWork ? " checked" : ""}><label for="openToWork">Show recruiters I'm open to work</label></div>`;
  }
  if (step === "skills") {
    inner = `<p>Add your top skills one at a time.</p><div id="chips" aria-live="polite"></div>
<label for="skillInput">Skill</label><div class="row"><input type="text" id="skillInput" placeholder="Add a skill, e.g. Python" list="skill-suggest" style="flex:4"><button type="button" class="btn secondary small" id="addSkill" style="flex:1">Add</button></div>
<datalist id="skill-suggest">${["JavaScript", "TypeScript", "React", "Python", "Go", "Rust", "Figma", "SQL", "Kubernetes"].map((s) => `<option value="${s}">`).join("")}</datalist><div id="skillFields"></div>`;
    script = `const chips=document.getElementById('chips'),fields=document.getElementById('skillFields'),inp=document.getElementById('skillInput');let skills=${JSON.stringify(pr.skills ?? [])};
function render(){chips.innerHTML='';fields.innerHTML='';skills.forEach((s,i)=>{const c=document.createElement('span');c.className='chip';c.textContent=s;const b=document.createElement('button');b.type='button';b.textContent='\\u00d7';b.setAttribute('aria-label','Remove '+s);b.onclick=()=>{skills.splice(i,1);render();};c.appendChild(b);chips.appendChild(c);
const h=document.createElement('input');h.type='hidden';h.name='skills';h.value=s;fields.appendChild(h);});}
function add(){const v=inp.value.trim();if(v&&!skills.some(s=>s.toLowerCase()===v.toLowerCase()))skills.push(v);inp.value='';render();inp.focus();}
document.getElementById('addSkill').onclick=add;inp.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();add();}});render();`;
  }
  const back = idx > 0 ? `<a class="btn secondary" href="/network/onboarding?step=${ONBOARD_STEPS[idx - 1]}">Back</a> ` : "";
  return netPage("Set up your profile", `<h1>Set up your profile</h1>${stepper}${error ? `<div class="errors" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/network/onboarding?step=${step}" novalidate>${inner}<div>${back}<button class="btn" type="submit">${step === "skills" ? "Finish" : "Next"}</button></div></form>`, { user, script });
}

function netProfile(user) {
  const pr = user.profile;
  const city = CITIES.find((c) => c.id === pr.location)?.name ?? "";
  const strength = profileStrength(user);
  return netPage("Profile", `<h1>${esc(user.firstName)} ${esc(user.lastName)}</h1><p>${esc(pr.headline)}<br><small>${esc(city)}</small></p>
<h3>Profile strength: ${strength}% complete</h3><div class="progress"><div style="width:${strength}%"></div></div>
<p><strong>Experience:</strong> ${esc(pr.yearsExperience ?? "")} years</p><p><strong>Skills:</strong> ${(pr.skills ?? []).map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</p>
${user.completed ? `<p class="ok">Your profile is complete.</p>` : ""}<p><a href="/network/onboarding">Edit profile</a> &middot; <a href="/network/jobs">Find jobs</a></p>`, { user });
}

const NET_FILTERS = { workplace: ["On-site", "Hybrid", "Remote"], level: ["Entry level", "Mid-level", "Senior", "Staff", "Director"], type: ["Full-time", "Contract", "Internship"] };

function netJobs(user, q) {
  const kw = norm(q.get("q"));
  const filters = Object.fromEntries(Object.keys(NET_FILTERS).map((k) => [k, q.get(k) ?? ""]));
  const hits = NET_JOBS.filter((j) => (!kw || norm(`${j.title} ${j.company}`).includes(kw)) && Object.entries(filters).every(([k, v]) => !v || j[k] === v));
  const per = 5;
  const pages = Math.max(1, Math.ceil(hits.length / per));
  const pageNo = Math.min(pages, Math.max(1, Number(q.get("page")) || 1));
  const shown = hits.slice((pageNo - 1) * per, pageNo * per);
  const select = (k, label) => `<div><label for="f-${k}">${label}</label><select id="f-${k}" name="${k}"><option value="">Any</option>${NET_FILTERS[k].map((o) => `<option${filters[k] === o ? " selected" : ""}>${o}</option>`).join("")}</select></div>`;
  const qs = (p) => { const n = new URLSearchParams(q); n.set("page", String(p)); return `/network/jobs?${n}`; };
  const rows = shown.map((j) => `<div class="job"><div><a href="/network/jobs/${j.id}"><strong>${esc(j.title)}</strong></a><br>${esc(j.company)}<br><small>${esc(j.location)} (${j.workplace}) &middot; ${j.level} &middot; ${j.type} &middot; ${j.posted}</small></div>${j.easy ? `<span class="badge">Easy Apply</span>` : ""}</div>`).join("");
  const pager = Array.from({ length: pages }, (_, i) => (i + 1 === pageNo ? `<strong>${i + 1}</strong>` : `<a href="${qs(i + 1)}">${i + 1}</a>`)).join(" ");
  return netPage("Jobs", `<h1>Jobs</h1><form method="get" action="/network/jobs"><label for="f-q">Search by title or company</label><input type="text" id="f-q" name="q" value="${esc(q.get("q"))}">
<div class="row">${select("workplace", "Workplace")}${select("level", "Experience level")}${select("type", "Job type")}</div><button class="btn small" type="submit" style="margin-top:12px">Search</button> <a href="/network/jobs">Clear</a></form>
<p>${hits.length ? `Showing ${(pageNo - 1) * per + 1}-${(pageNo - 1) * per + shown.length} of ${hits.length} results` : "No jobs match your search."}</p>${rows}<p>Page: ${pager}</p>`, { user });
}

function netJobDetail(user, j) {
  const meta = `${esc(j.company)} &middot; ${esc(j.location)} (${j.workplace}) &middot; ${j.level} &middot; ${j.type}`;
  let cta = "";
  if (!j.easy) cta = `<a class="btn secondary" href="/network/jobs/${j.id}/external">Apply on company website</a>`;
  else if (!user) cta = `<a class="btn" href="/network/login?next=${encodeURIComponent(`/network/jobs/${j.id}`)}">Sign in to Easy Apply</a>`;
  else if (!user.verified) cta = `<p class="notice">Verify your email to use Easy Apply. <a href="/network/check-email">Details</a></p>`;
  else cta = `<button class="btn" type="button" id="easy">Easy Apply</button>`;
  const body = `<p><a href="/network/jobs">&larr; Back to search</a></p><h1>${esc(j.title)}</h1><p>${meta}</p><p><small>Job ID ${j.id} &middot; ${j.posted}</small></p>
<h3>About the job</h3><p>${esc(j.company)} is hiring a ${esc(j.title)} to build ambitious products with a small team.</p>${cta}`;
  if (!j.easy || !user?.verified) return netPage(j.title, body, { user });
  const modal = `<div id="ea" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="ea-title"><div class="modal-box">
<div class="modal-head"><h2 id="ea-title">Apply to ${esc(j.company)}</h2><button type="button" id="ea-close" aria-label="Dismiss">&times;</button></div>
<div class="progress"><div id="ea-bar" style="width:33%"></div></div>
<form method="post" action="/network/jobs/${j.id}/easy-apply" id="ea-form" novalidate>
<section data-step="1"><h3>Contact info</h3><p><strong>${esc(user.firstName)} ${esc(user.lastName)}</strong><br><small>${esc(user.profile.headline ?? "")}</small></p>
<label for="ea-email">Email address *</label><select id="ea-email" name="email"><option value="">Select an option</option><option value="${esc(user.email)}">${esc(user.email)}</option></select>
<label for="ea-country">Phone country code *</label><select id="ea-country" name="phoneCountry"><option value="+1">United States (+1)</option><option value="+44">United Kingdom (+44)</option><option value="+91">India (+91)</option></select>
<label for="ea-phone">Mobile phone number *</label><input type="tel" id="ea-phone" name="phone"></section>
<section data-step="2" hidden><h3>Additional questions</h3>
<label for="ea-years">How many years of professional experience do you have? *</label><input type="number" id="ea-years" name="yearsExperience" min="0" max="60">
<p style="font-weight:600;margin:14px 0 4px">Are you legally authorized to work in the United States? *</p><div class="inline"><input type="radio" id="ea-wa-yes" name="workAuth" value="yes"><label for="ea-wa-yes">Yes</label><input type="radio" id="ea-wa-no" name="workAuth" value="no"><label for="ea-wa-no">No</label></div></section>
<section data-step="3" hidden><h3>Review your application</h3><table class="list" id="ea-review"></table><p class="hint">The employer will receive your Network profile and the answers above.</p></section>
<div class="error" id="ea-error" role="alert"></div>
<div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn secondary" id="ea-back" hidden>Back</button><button type="button" class="btn" id="ea-next">Next</button><button type="submit" class="btn" id="ea-submit" hidden>Submit application</button></div>
</form></div></div>`;
  const script = `const m=document.getElementById('ea'),f=document.getElementById('ea-form'),err=document.getElementById('ea-error');let step=1;
const secs=[...f.querySelectorAll('section')],next=document.getElementById('ea-next'),back=document.getElementById('ea-back'),sub=document.getElementById('ea-submit');
function show(){secs.forEach(s=>s.hidden=Number(s.dataset.step)!==step);back.hidden=step===1;next.hidden=step===3;sub.hidden=step!==3;document.getElementById('ea-bar').style.width=(step*33.4)+'%';err.textContent='';
if(step===3){const wa=f.querySelector('input[name=workAuth]:checked');document.getElementById('ea-review').innerHTML=[['Email',f.email.value],['Phone',f.phoneCountry.value+' '+f.phone.value],['Years of experience',f.yearsExperience.value],['Authorized to work in the US',wa?wa.value:'']].map(r=>'<tr><td>'+r[0]+'</td><td>'+r[1].replace(/</g,'&lt;')+'</td></tr>').join('');}}
function valid(){if(step===1){if(!f.email.value)return 'Select an email address.';if(f.phone.value.replace(/\\D/g,'').length<7)return 'Enter a valid phone number.';}
if(step===2){if(f.yearsExperience.value==='')return 'Answer the years of experience question.';if(!f.querySelector('input[name=workAuth]:checked'))return 'Answer the work authorization question.';}return '';}
next.onclick=()=>{const e=valid();if(e){err.textContent=e;return;}step++;show();};back.onclick=()=>{step--;show();};
document.getElementById('easy').onclick=()=>{m.classList.remove('hidden');step=1;show();};document.getElementById('ea-close').onclick=()=>m.classList.add('hidden');`;
  return netPage(j.title, body, { user, script, after: modal });
}

function netConsent(user, clientId, jobId) {
  const client = SITES[clientId];
  return netPage("Allow access", `<h1>${esc(client.name)} wants to access your Network account</h1><p>Signed in as <strong>${esc(user.firstName)} ${esc(user.lastName)}</strong> (${esc(user.email)})</p>
<p>This will allow ${esc(client.name)} to:</p><ul><li>See your name and email address</li><li>See your profile headline</li></ul>
<form method="post" action="/network/oauth/authorize"><input type="hidden" name="client_id" value="${esc(clientId)}"><input type="hidden" name="job" value="${esc(jobId)}">
<button class="btn secondary" type="submit" name="decision" value="deny">Cancel</button> <button class="btn" type="submit" name="decision" value="allow">Allow</button></form>`, { user });
}

async function handleNetwork(req, res, parts, u) {
  const [, , section, id, action] = parts;
  const user = sessionUser(req, "net_sid", state.netSessions, state.net);
  const loginRedirect = () => redirect(res, `/network/login?next=${encodeURIComponent(u.pathname + u.search)}`);
  if (!section) return user ? send(res, 200, netHome(user)) : send(res, 200, netPage("Welcome", `<h1>Welcome to your professional community</h1><p>Find jobs, grow your network, and apply in one click.</p><a class="btn" href="/network/signup">Join now</a> <a class="btn secondary" href="/network/login">Sign in</a>`));
  if (section === "signup" && req.method === "GET") return send(res, 200, netSignup());
  if (section === "signup" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    const v = { email: norm(p.get("email")), firstName: (p.get("firstName") ?? "").trim(), lastName: (p.get("lastName") ?? "").trim() };
    const password = p.get("password") ?? "";
    let error = "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) error = "Please enter a valid email address.";
    else if (state.net.has(v.email)) error = "Someone's already using that email. Sign in instead.";
    else if (password.length < 8) error = "Password must be 8 characters or more.";
    else if (!v.firstName || !v.lastName) error = "Please enter your first and last name.";
    if (error) return send(res, 200, netSignup(v, error));
    const account = { ...v, password, verified: false, profile: {}, completed: false, createdAt: new Date().toISOString() };
    state.net.set(v.email, account);
    state.netOrder.push(v.email);
    console.log(`[bench-sites] network account created: ${v.email}`);
    sendVerification(account);
    return redirect(res, "/network/check-email", startSession("net_sid", "/network", state.netSessions, v.email));
  }
  if (section === "login" && req.method === "GET") return send(res, 200, netLogin(u.searchParams.get("next") ?? ""));
  if (section === "login" && req.method === "POST") {
    const p = new URLSearchParams(await readBody(req));
    const account = state.net.get(norm(p.get("email")));
    const next = p.get("next") ?? "";
    if (!account || account.password !== p.get("password")) return send(res, 200, netLogin(next, "Wrong email or password. Try again.", p.get("email") ?? ""));
    return redirect(res, next.startsWith("/network/") ? next : "/network", startSession("net_sid", "/network", state.netSessions, account.email));
  }
  if (section === "logout") return redirect(res, "/network", "net_sid=; Path=/network; Max-Age=0");
  if (section === "verify") {
    const email = state.verifyTokens.get(u.searchParams.get("token") ?? "");
    const account = email && state.net.get(email);
    if (!account) return send(res, 400, netPage("Link expired", `<h1>This link is invalid or has expired</h1><p><a href="/network">Go to Network</a></p>`, { user }));
    account.verified = true;
    console.log(`[bench-sites] network account verified: ${email}`);
    return send(res, 200, netPage("Email verified", `<h1>Your email is verified</h1><p class="ok">Thanks, ${esc(account.firstName)}. ${esc(account.email)} is confirmed.</p><a class="btn" href="/network/onboarding">Set up your profile</a>`, { user: account }), "text/html; charset=utf-8", startSession("net_sid", "/network", state.netSessions, account.email));
  }
  if (section === "jobs" && !id) return send(res, 200, netJobs(user, u.searchParams));
  if (section === "jobs") {
    const j = NET_JOBS.find((x) => x.id === id);
    if (!j) return send(res, 404, netPage("Not found", "<h1>Job not found</h1>", { user }));
    if (!action) return send(res, 200, netJobDetail(user, j));
    if (action === "external") return send(res, 200, netPage("External site", `<h1>External application</h1><p>This posting is handled on the company's own website, which is not available in this practice world.</p><p><a href="/network/jobs">Back to jobs</a></p>`, { user }));
    if (action === "easy-apply" && req.method === "POST") {
      if (!user) return loginRedirect();
      if (!user.verified || !j.easy) return send(res, 403, netVerifyWall(user));
      const p = new URLSearchParams(await readBody(req));
      p.set("fullName", `${user.firstName} ${user.lastName}`);
      record("network", j.id, p);
      return send(res, 200, netPage("Application sent", `<h1>Your application was sent to ${esc(j.company)}</h1><p class="ok">Application for ${esc(j.title)} submitted.</p><p><a href="/network/jobs">Back to jobs</a></p>`, { user }));
    }
    return send(res, 404, netPage("Not found", "<h1>Page not found</h1>", { user }));
  }
  if (!user) return loginRedirect();
  if (section === "check-email") return send(res, 200, user.verified ? netHome(user) : netVerifyWall(user));
  if (section === "resend" && req.method === "POST") {
    if (!user.verified) sendVerification(user);
    return send(res, 200, netVerifyWall(user, true));
  }
  if (section === "profile") return send(res, 200, netProfile(user));
  if (section === "onboarding") {
    if (!user.verified) return send(res, 200, netVerifyWall(user));
    const step = ONBOARD_STEPS.includes(u.searchParams.get("step")) ? u.searchParams.get("step") : "about";
    if (req.method === "GET") return send(res, 200, netOnboarding(user, step));
    const p = new URLSearchParams(await readBody(req));
    const pr = user.profile;
    if (step === "about") {
      const headline = (p.get("headline") ?? "").trim();
      const location = p.get("location") ?? "";
      if (!headline || !CITIES.some((c) => c.id === location)) return send(res, 200, netOnboarding(user, step, "Add a headline and choose your location."));
      Object.assign(pr, { headline, location });
      return redirect(res, "/network/onboarding?step=experience");
    }
    if (step === "experience") {
      const years = (p.get("yearsExperience") ?? "").trim();
      if (!/^\d{1,2}$/.test(years)) return send(res, 200, netOnboarding(user, step, "Enter your years of experience as a number."));
      Object.assign(pr, { yearsExperience: String(Number(years)), openToWork: p.has("openToWork") });
      return redirect(res, "/network/onboarding?step=skills");
    }
    const skills = p.getAll("skills").map((s) => s.trim()).filter(Boolean);
    if (!skills.length) return send(res, 200, netOnboarding(user, step, "Add at least one skill."));
    pr.skills = skills;
    user.completed = true;
    console.log(`[bench-sites] network profile completed: ${user.email} (${profileStage().completeness}% correct)`);
    return redirect(res, "/network/profile");
  }
  if (section === "oauth" && id === "authorize") {
    const q = req.method === "POST" ? new URLSearchParams(await readBody(req)) : u.searchParams;
    const clientId = q.get("client_id") ?? "";
    const jobId = q.get("job") ?? "";
    if (clientId !== "wayne") return send(res, 400, netPage("Error", "<h1>Unknown application</h1>", { user }));
    if (!user.verified) return send(res, 200, netVerifyWall(user));
    if (req.method === "GET") return send(res, 200, netConsent(user, clientId, jobId));
    if (q.get("decision") !== "allow") return send(res, 200, wayneDone(`/wayne/jobs/${encodeURIComponent(jobId)}/apply?error=access_denied`));
    const code = newId("g");
    state.grants.set(code, { client: clientId, email: user.email, name: `${user.firstName} ${user.lastName}`, headline: user.profile.headline ?? "", job: jobId });
    console.log(`[bench-sites] network granted ${clientId} access for ${user.email}`);
    return redirect(res, `/wayne/oauth/done?job=${encodeURIComponent(jobId)}&code=${code}`);
  }
  return send(res, 404, netPage("Not found", "<h1>Page not found</h1>", { user }));
}

// ---------------------------------------------------------------- server plumbing

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "text/html; charset=utf-8", cookie) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
  res.end(body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value, null, 2), "application/json");
function redirect(res, location, cookie) {
  res.writeHead(303, { location, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
  res.end();
}

function cookiesOf(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
}
function sessionUser(req, name, sessions, accounts) {
  const key = sessions.get(cookiesOf(req)[name]);
  return key ? accounts.get(key) : undefined;
}
function startSession(name, path, sessions, key) {
  const sid = newId("s");
  sessions.set(sid, key);
  return `${name}=${sid}; Path=${path}; HttpOnly; SameSite=Lax`;
}

// The consent cookie carries the reset epoch so a persistent browser profile sees the overlay again after /__reset.
let consentEpoch = Date.now().toString(36);
function hasConsent(req) {
  return new RegExp(`(?:^|;\\s*)umbrella_consent=\\w+\\.${consentEpoch}(?:;|$)`).test(req.headers.cookie ?? "");
}

function home() {
  const jobs = JOB_SITES.map((k) => (k === "network" ? `<li><a href="/network/jobs">Network Jobs</a> (Easy Apply)</li>` : `<li><a href="/${k}">${esc(SITES[k].name)}</a></li>`)).join("");
  return `<!doctype html><title>Practice world</title><h1>Practice world</h1><ul><li><a href="/mail">Mail</a> (create an @${MAIL_DOMAIN} address)</li><li><a href="/network">Network</a> (professional network)</li></ul><h2>Careers sites</h2><ul>${jobs}</ul>`;
}

async function handle(req, res, base) {
  const u = new URL(req.url, base);
  const path = u.pathname.replace(/\/+$/, "") || "/";

  if (path === "/__results" && req.method === "GET") return json(res, 200, results(base));
  if (path === "/__reset" && req.method === "POST") {
    state = freshState();
    consentEpoch = Date.now().toString(36);
    return json(res, 200, { ok: true });
  }
  if (path === "/__seed" && req.method === "GET") return redirect(res, "/", seed(u.searchParams.get("stage") ?? ""));
  if (path === "/") return send(res, 200, home());

  const parts = path.split("/");
  const [, site, section, jobId, action, sub, step] = parts;
  if (site === "mail") return handleMail(req, res, parts);
  if (site === "network") return handleNetwork(req, res, parts, u);
  const s = SITES[site];
  if (!s) return send(res, 404, "Not found", "text/plain");
  const overlay = site === "umbrella" && !hasConsent(req);

  if (site === "hooli" && section === "api" && jobId === "cities") {
    const q = (u.searchParams.get("q") ?? "").trim().toLowerCase();
    return json(res, 200, q.length < 2 ? [] : CITIES.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6));
  }
  if (site === "wayne" && section === "oauth" && jobId === "done") {
    const target = `/wayne/jobs/${encodeURIComponent(u.searchParams.get("job") ?? "")}/apply?code=${encodeURIComponent(u.searchParams.get("code") ?? "")}`;
    return send(res, 200, wayneDone(target));
  }
  if (site === "cyberdyne" && section === "confirm") {
    const entry = state.confirmTokens.get(u.searchParams.get("token") ?? "");
    if (!entry) return send(res, 400, page(site, "Invalid link", "<h1>This confirmation link is invalid</h1>"));
    entry.confirmed = true;
    console.log(`[bench-sites] cyberdyne application confirmed via email (${entry.fieldsCorrect ? "correct" : "incorrect"})`);
    return send(res, 200, page(site, "Application confirmed", thanks(site, `<p class="ok">Your email address is confirmed and your application is now submitted.</p>`)));
  }
  if (site === "tyrell" && section === "embed") {
    const job = JOBS.find((j) => s.ids[j.key] === jobId);
    if (!job) return send(res, 404, "Not found", "text/plain");
    if (req.method === "POST") {
      record(site, jobId, new URLSearchParams(await readBody(req)));
      return send(res, 200, tyrellEmbed(jobId, job, true));
    }
    return send(res, 200, tyrellEmbed(jobId, job));
  }
  if (!section) return send(res, 200, page(site, "Open positions", listing(site), { overlay }));
  if (section !== "jobs") return send(res, 404, page(site, "Not found", "<h1>Page not found</h1>"));

  const job = JOBS.find((j) => s.ids[j.key] === jobId);
  if (!job) return send(res, 404, page(site, "Not found", "<h1>Job not found</h1>"));
  if (!action && req.method === "GET") return send(res, 200, page(site, job.title, detail(site, job), { overlay }));

  const applyPath = `/${site}/jobs/${jobId}/apply`;
  if (site === "soylent" && action === "apply") {
    if (!sub) {
      const draftId = newId("d");
      state.drafts.set(draftId, { jobId, values: {} });
      return redirect(res, `${applyPath}/${draftId}/contact`);
    }
    const draft = state.drafts.get(sub);
    const stepIdx = SOYLENT_STEPS.findIndex((x) => x.key === step);
    if (!draft || draft.jobId !== jobId || stepIdx < 0) return redirect(res, applyPath);
    if (req.method === "GET") return send(res, 200, page(site, `Apply: ${job.title}`, soylentStep(jobId, job, sub, step, draft.values)));
    const params = new URLSearchParams(await readBody(req));
    if (step === "review") {
      const missingStep = SOYLENT_STEPS.slice(0, 3).find((x) => Object.keys(soylentValidate(x.key, new URLSearchParams(draft.values)).errors).length);
      if (missingStep) return redirect(res, `${applyPath}/${sub}/${missingStep.key}`);
      record(site, jobId, new URLSearchParams(draft.values));
      state.drafts.delete(sub);
      return send(res, 200, page(site, "Application received", thanks(site)));
    }
    const { values, errors } = soylentValidate(step, params);
    Object.assign(draft.values, values);
    if (Object.keys(errors).length) return send(res, 200, page(site, `Apply: ${job.title}`, soylentStep(jobId, job, sub, step, draft.values, errors)));
    return redirect(res, `${applyPath}/${sub}/${SOYLENT_STEPS[stepIdx + 1].key}`);
  }
  if (action === "apply" && req.method === "GET") {
    let built;
    if (site === "wayne") {
      const code = u.searchParams.get("code") ?? "";
      const grant = state.grants.get(code);
      built = grant && grant.client === "wayne"
        ? wayneForm(applyPath, job, code, grant)
        : wayneStart(jobId, job, u.searchParams.get("error") ? "You cancelled Network access. Wayne Enterprises needs it to receive your application." : code ? "That Network authorization is invalid. Try again." : "");
    } else if (site === "tyrell") built = tyrellHost(jobId, job);
    else built = { acme: acmeForm, globex: globexForm, initech: initechForm, umbrella: umbrellaForm, hooli: hooliForm, cyberdyne: cyberdyneForm }[site](applyPath, job);
    const { body, script } = typeof built === "string" ? { body: built, script: "" } : built;
    return send(res, 200, page(site, `Apply: ${job.title}`, body, { script, overlay }));
  }
  if (action === "apply" && req.method === "POST") {
    const params = new URLSearchParams(await readBody(req));
    if (site === "umbrella") {
      return send(res, 200, page(site, "Review application", umbrellaConfirm(`/${site}/jobs/${jobId}/confirm`, applyPath, params), { overlay }));
    }
    if (site === "wayne") {
      const grant = state.grants.get(params.get("networkCode") ?? "");
      const extraWrong = grant && norm(grant.email) !== norm(params.get("email")) ? [{ field: "email", expected: grant.email, got: params.get("email"), note: "differs from the Network account that granted access" }] : [];
      record(site, jobId, params, { extraWrong });
      return send(res, 200, page(site, "Application received", thanks(site)));
    }
    if (site === "cyberdyne") {
      const check = record(site, jobId, params, { confirmed: false });
      const token = newId("c");
      state.confirmTokens.set(token, check);
      const to = params.get("email") ?? "";
      sendMail(to, "Cyberdyne Talent <talent@cyberdyne.test>", `Confirm your application: ${job.title}`, `<p>Hello ${esc(params.get("fullName"))},</p><p>We received your application for <strong>${esc(job.title)}</strong>. To protect against automated submissions, please confirm it within 24 hours:</p>
<p><a href="${BASE}/cyberdyne/confirm?token=${token}" style="background:#8a1c1c;color:#fff;padding:10px 18px;text-decoration:none;font-weight:bold">Confirm my application</a></p><p style="font-size:12px;color:#666">If you did not apply, ignore this email.</p>`);
      return send(res, 200, page(site, "Confirm your application", `<h1>Almost done &mdash; confirm your application</h1><p class="notice">We emailed a confirmation link to <strong>${esc(to)}</strong>. Your application is <strong>not submitted</strong> until you click the link in that email.</p><p><a href="/${site}">Back to all jobs</a></p>`));
    }
    record(site, jobId, params);
    return send(res, 200, page(site, "Application received", thanks(site)));
  }
  if (site === "umbrella" && action === "confirm" && req.method === "POST") {
    record(site, jobId, new URLSearchParams(await readBody(req)));
    return send(res, 200, page(site, "Application received", thanks(site)));
  }
  return send(res, 404, page(site, "Not found", "<h1>Page not found</h1>"));
}

export function startSites(port = 4777, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    BASE = base;
    const server = http.createServer((req, res) => {
      handle(req, res, base).catch((error) => {
        console.error("[bench-sites]", error);
        if (!res.headersSent) send(res, 500, String(error?.message ?? error), "text/plain");
      });
    });
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, base }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : 4777;
  const { base } = await startSites(port);
  console.log(`[bench-sites] listening on ${base} (/mail /network ${Object.keys(SITES).map((k) => `/${k}`).join(" ")})`);
}
