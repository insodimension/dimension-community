// Video of a benchmark run: the same live pictures the View shows (the pack's direct stream, `browser_stream`),
// captured with their arrival time, then encoded by ffmpeg with a caption track burned in — the agent, the stage,
// a stage timer, a run timer and the agent's latest step. One recorder per agent (one browser).
//
// The pictures are read from the same stream the View reads, so the video shows exactly what a person
// watching the View would have seen, at the pace they would have seen it.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The stream's framing (src/wire.ts): kind u8, JSON length u32le, body length u32le, the JSON, the body. Kind 1 is a picture, its body a JPEG. */
const HEADER_BYTES = 9;
const KIND_PICTURE = 1;
const RETRY_MS = 200;

const clock = (s) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const assTime = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};
/** ASS text: braces open override blocks and a backslash escapes, so neither may reach it raw. */
const assText = (s) => String(s).replace(/[{}]/g, "").replace(/\\/g, "/").replace(/\r?\n/g, " ");

export function startRecorder({ call, browserId, dir, title }) {
  mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  const now = () => (performance.now() - t0) / 1000;
  const frames = [];
  /** Caption state changes over time: { at, stage, stageStart, step, verdict }. */
  const marks = [];
  let state = { stage: "", stageStart: 0, step: "", verdict: "" };
  let stopped = false;
  const reading = new AbortController();

  const mark = (patch) => {
    state = { ...state, ...patch };
    marks.push({ at: now(), ...state });
  };

  const save = (jpeg) => {
    const file = `f${String(frames.length).padStart(6, "0")}.jpg`;
    writeFileSync(join(dir, file), jpeg);
    frames.push({ file, at: now() });
  };

  const loop = (async () => {
    while (!stopped) {
      try {
        const { origin, token } = await call("browser_stream", { browserId });
        const response = await fetch(`${origin}/s/${token}`, { signal: reading.signal });
        const reader = response.body.getReader();
        let buffer = Buffer.alloc(0);
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = Buffer.concat([buffer, value]);
          while (buffer.length >= HEADER_BYTES) {
            const json = buffer.readUInt32LE(1);
            const end = HEADER_BYTES + json + buffer.readUInt32LE(5);
            if (buffer.length < end) break;
            if (buffer[0] === KIND_PICTURE) save(buffer.subarray(HEADER_BYTES + json, end));
            buffer = buffer.subarray(end);
          }
        }
      } catch {
        /* the stream ends when the browser closes, and can miss while the pack restarts: ask again */
      }
      if (!stopped) await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  })();

  return {
    stage(stage) { mark({ stage, stageStart: now(), step: "", verdict: "" }); },
    step(step) { mark({ step }); },
    verdict(verdict) { mark({ verdict }); },
    /** Stops reading and encodes `<dir>.mp4`. Returns its path, or null when there is nothing to encode. */
    async finish(outFile) {
      stopped = true;
      reading.abort();
      await loop;
      const end = now();
      if (!frames.length) return null;
      const concat = ["ffconcat version 1.0"];
      frames.forEach((f, i) => {
        const next = frames[i + 1]?.at ?? end;
        concat.push(`file '${f.file}'`, `duration ${Math.max(0.001, next - f.at).toFixed(3)}`);
      });
      concat.push(`file '${frames.at(-1).file}'`);
      writeFileSync(join(dir, "frames.ffconcat"), `${concat.join("\n")}\n`);
      writeFileSync(join(dir, "captions.ass"), captions(title, marks, frames[0].at, end));
      const result = spawnSync("ffmpeg", [
        "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.ffconcat",
        "-vf", "scale=1280:-2:flags=lanczos,pad=iw:ih+96:0:96:color=0x0b0d12,subtitles=captions.ass",
        "-r", "15", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        outFile,
      ], { cwd: dir, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr || result.error?.message}`);
      return outFile;
    },
  };
}

/**
 * Caption track. The header band (96 px, painted by the pad filter) carries the title and the
 * current stage on the left, the stage timer and run timer on the right; the latest step and a
 * pass/fail verdict sit at the bottom. Timers tick at 10 Hz as separate events.
 */
function captions(title, marks, first, end) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 816
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Segoe UI,26,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,7,24,24,14,1
Style: Stage,Segoe UI,20,&H00B8C4D6,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,24,24,54,1
Style: Clock,Consolas,34,&H0080E0FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,9,24,24,10,1
Style: Stageclock,Consolas,20,&H00B8C4D6,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,9,24,24,58,1
Style: Step,Segoe UI,20,&H00FFFFFF,&H00FFFFFF,&H30181410,&H00000000,0,0,0,0,100,100,0,0,3,8,0,1,24,24,18,1
Style: Pass,Segoe UI,30,&H00FFFFFF,&H00FFFFFF,&H00409028,&H00000000,1,0,0,0,100,100,0,0,3,12,0,3,24,24,18,1
Style: Fail,Segoe UI,30,&H00FFFFFF,&H00FFFFFF,&H003030C0,&H00000000,1,0,0,0,100,100,0,0,3,12,0,3,24,24,18,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = [];
  const at = (t) => Math.max(0, t - first);
  const span = at(end);
  const shown = assText(title);
  events.push(`Dialogue: 0,${assTime(0)},${assTime(span)},Title,,0,0,0,,${shown.length > 88 ? `${shown.slice(0, 87)}…` : shown}`);
  marks.forEach((m, i) => {
    const from = at(m.at);
    const to = at(marks[i + 1]?.at ?? end);
    if (to <= from) return;
    if (m.stage) events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Stage,,0,0,0,,${assText(m.stage)}`);
    if (m.step) events.push(`Dialogue: 0,${assTime(from)},${assTime(to)},Step,,0,0,0,,${assText(m.step).slice(0, 150)}`);
    if (m.verdict) events.push(`Dialogue: 1,${assTime(from)},${assTime(to)},${m.verdict.startsWith("PASS") ? "Pass" : "Fail"},,0,0,0,,${assText(m.verdict)}`);
  });
  // Timers: run clock from the first frame; stage clock from the current stage's start.
  for (let t = 0; t < span; t += 0.1) {
    const real = t + first;
    const m = marks.findLast((x) => x.at <= real);
    events.push(`Dialogue: 0,${assTime(t)},${assTime(Math.min(span, t + 0.1))},Clock,,0,0,0,,${clock(real)}`);
    if (m?.stage && !m.verdict) events.push(`Dialogue: 0,${assTime(t)},${assTime(Math.min(span, t + 0.1))},Stageclock,,0,0,0,,stage ${clock(real - m.stageStart)}`);
  }
  return head + events.join("\n") + "\n";
}
