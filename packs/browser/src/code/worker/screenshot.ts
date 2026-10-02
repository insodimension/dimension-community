// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (describeScreenshot, preparePageForScreenshot, #captureScreenshot), tools/render-utils.ts (formatScreenshot, shortenPath) and utils/image-resize.ts (formatDimensionNote) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack (matrix D13, D14, H9): the model's picture is encoded by Chrome at its final size (clip scale, WebP q70, the longest edge at most 1024, at most 150 KiB, as the
// engine's shotForModel does) where OMP captures a PNG and shrinks it with Bun.Image, which Node does not have; the full-resolution PNG is a second capture and is taken only when a screenshot
// directory is set. Caption lines, the dimension note, the file naming and the destination rules are OMP's.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CDPSession, ElementHandle, Page } from "puppeteer-core";
import type { ImageBlock, RunResult, ScreenshotResult } from "../contracts";
import { ToolError } from "../errors";
import { untilAborted } from "./abortable";
import { readImageDimensions } from "./image-size";
import type { RunOutput } from "./run-output";

export interface ScreenshotOptions {
  selector?: string;
  fullPage?: boolean;
  silent?: boolean;
}

/** Where a screenshot goes and how it may be taken (the realm's settings, H9). */
export interface ShotConfig {
  /** `DIMENSION_BROWSER_SCREENSHOT_DIR`: the full-resolution PNG lands here. Unset: the model's picture is saved under the OS temp directory. */
  dir?: string;
  /** JPEG instead of WebP for the model's picture (backends that cannot decode WebP). */
  excludeWebP: boolean;
  /** Raise the tab before capturing; false for a visible user-driven tab, which must already be on screen. */
  activate: boolean;
}

/** The model's picture: at most this long on its longest edge, this small in bytes, this lossy at first. */
export const MODEL_SHOT_EDGE = 1024;
export const MODEL_SHOT_MAX_BYTES = 150 * 1024;
export const MODEL_SHOT_QUALITY = 70;
/** Vision backends reject degenerate pictures (a 1x1 chart): smaller captures are scaled up to this edge. */
const MODEL_SHOT_MIN_EDGE = 200;
const QUALITY_STEPS = [60, 50, 40] as const;
const SCALE_STEPS = [0.75, 0.5, 0.35, 0.25] as const;

/** Human-readable label for a screenshot op, used in op tracking + timeout errors. */
export function describeScreenshot(opts?: ScreenshotOptions): string {
  if (opts?.selector) return `tab.screenshot({ selector: ${JSON.stringify(opts.selector)} })`;
  if (opts?.fullPage) return "tab.screenshot({ fullPage: true })";
  return "tab.screenshot()";
}

export async function preparePageForScreenshot(
  page: Pick<Page, "bringToFront" | "evaluate">,
  signal: AbortSignal | undefined,
  activate: boolean,
): Promise<void> {
  if (activate) {
    await untilAborted(signal, () => page.bringToFront()).catch(() => undefined);
    return;
  }
  const visible = await untilAborted(signal, () => page.evaluate(() => document.visibilityState === "visible")).catch(
    () => false,
  );
  if (!visible) {
    throw new ToolError("The attached browser tab is not visible; switch to it before taking a screenshot");
  }
}

/** What the model's picture ended up as, against the full-resolution capture it stands for. */
export interface ShotInfo {
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

/** `~` for the home directory, as OMP prints a saved path. */
export function shortenPath(filePath: string, homeDir: string = os.homedir()): string {
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(homeDir) || homeDir.startsWith("\\\\");
  const hasHomePrefix = windowsStyle ? filePath.toLowerCase().startsWith(homeDir.toLowerCase()) : filePath.startsWith(homeDir);
  if (homeDir && hasHomePrefix) {
    const suffix = filePath.slice(homeDir.length);
    if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
      return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
    }
  }
  return filePath;
}

function formatDimensionNote(info: ShotInfo): string | undefined {
  if (!info.originalWidth || !info.originalHeight || !info.width || !info.height) return undefined;
  if (info.width === info.originalWidth && info.height === info.originalHeight) return undefined;
  const scale = info.originalWidth / info.width;
  return `[Image: original ${info.originalWidth}x${info.originalHeight}, displayed at ${info.width}x${info.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

/** The caption lines printed above the picture (matrix D14). */
export function formatScreenshot(opts: {
  saveFullRes: boolean;
  savedMimeType: string;
  savedByteLength: number;
  dest: string;
  resized: ShotInfo;
}): string[] {
  const lines = ["Screenshot captured"];
  if (opts.saveFullRes) {
    lines.push(`Saved: ${opts.savedMimeType} (${(opts.savedByteLength / 1024).toFixed(2)} KB) to ${shortenPath(opts.dest)}`);
    lines.push(`Model: ${opts.resized.mimeType} (${(opts.resized.bytes / 1024).toFixed(2)} KB, ${opts.resized.width}x${opts.resized.height})`);
  } else {
    lines.push(`Format: ${opts.resized.mimeType} (${(opts.resized.bytes / 1024).toFixed(2)} KB)`);
    lines.push(`Dimensions: ${opts.resized.width}x${opts.resized.height}`);
  }
  const dimensionNote = formatDimensionNote(opts.resized);
  if (dimensionNote) lines.push(dimensionNote);
  return lines;
}

/** `DIMENSION_BROWSER_SCREENSHOT_DIR` with a leading `~` expanded (H9); unset or blank is undefined. */
export function resolveScreenshotDir(env: Readonly<Record<string, string | undefined>>, home: string = os.homedir()): string | undefined {
  const raw = env.DIMENSION_BROWSER_SCREENSHOT_DIR?.trim();
  if (!raw) return undefined;
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return raw;
}

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Wholly inside the visible viewport: the page need not be laid out beyond it to capture. */
  inView: boolean;
}

interface Measured {
  region: Region;
  dpr: number;
}

export interface ShotTarget {
  page: Page;
  /** A CDP session on the page (layout metrics). */
  cdp(): Promise<CDPSession>;
  /** The element for `selector` (aria-ref aware), or null when it matches nothing. */
  resolveElement(selector: string): Promise<ElementHandle | null>;
}

/** Bring the element into view with one instant scroll: puppeteer's scrollIntoViewIfNeeded can stall for ever on continuously animating pages. Best-effort. */
async function scrollElementIntoView(handle: ElementHandle, signal: AbortSignal | undefined): Promise<void> {
  await untilAborted(signal, () =>
    handle.evaluate(el => {
      const target = el as unknown as { scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void };
      target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    }),
  ).catch(() => undefined);
}

async function measure(target: ShotTarget, opts: ScreenshotOptions, signal: AbortSignal | undefined): Promise<Measured> {
  const { page } = target;
  const cdp = await untilAborted(signal, () => target.cdp());
  const [metrics, dpr] = await Promise.all([
    untilAborted(signal, () => cdp.send("Page.getLayoutMetrics")),
    untilAborted(signal, () => page.evaluate(() => window.devicePixelRatio)),
  ]);
  const view = metrics.cssVisualViewport;
  const viewport: Region = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, inView: true };
  if (opts.selector !== undefined) {
    const handle = await target.resolveElement(opts.selector);
    if (!handle) throw new ToolError("Screenshot selector did not resolve to an element");
    try {
      await scrollElementIntoView(handle, signal);
      const box = await untilAborted(signal, () => handle.boundingBox());
      if (!box || box.width < 1 || box.height < 1) {
        throw new ToolError(`Screenshot selector ${JSON.stringify(opts.selector)} has no visible box to capture`);
      }
      // boundingBox is in viewport pixels: add the viewport's own page offset for document pixels.
      const region = { x: box.x + view.pageX, y: box.y + view.pageY, width: box.width, height: box.height };
      const inView = box.x >= 0 && box.y >= 0 && box.x + box.width <= view.clientWidth && box.y + box.height <= view.clientHeight;
      return { region: { ...region, inView }, dpr: dpr || 1 };
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }
  if (opts.fullPage) {
    const size = metrics.cssContentSize;
    return { region: { x: 0, y: 0, width: size.width, height: size.height, inView: false }, dpr: dpr || 1 };
  }
  return { region: viewport, dpr: dpr || 1 };
}

/** Pixels per CSS pixel for the model's picture: native when it fits, shrunk to the longest edge otherwise, never below the vision floor. */
function modelPixelRatio(region: Region, dpr: number): number {
  const longest = Math.max(region.width, region.height);
  const shortest = Math.min(region.width, region.height);
  let ratio = Math.min(dpr, MODEL_SHOT_EDGE / longest);
  if (shortest * ratio < MODEL_SHOT_MIN_EDGE) ratio = Math.min(MODEL_SHOT_MIN_EDGE / shortest, MODEL_SHOT_EDGE / longest);
  return ratio;
}

function extensionOf(mimeType: string): string {
  return mimeType === "image/webp" ? "webp" : mimeType === "image/jpeg" ? "jpg" : "png";
}

/**
 * Take the screenshot, print its caption and picture into the run's output, record it, and return where it was saved (matrix D13). The saved file is the
 * full-resolution PNG when a directory is configured, else the model's own picture under the OS temp directory.
 */
export async function captureScreenshot(
  target: ShotTarget,
  config: ShotConfig,
  output: RunOutput,
  screenshots: ScreenshotResult[],
  signal: AbortSignal | undefined,
  opts: ScreenshotOptions = {},
): Promise<string> {
  const { page } = target;
  // Sibling tabs share one Chromium: CDP captures read the compositor surface of the ACTIVE target, so a backgrounded page can stall for a frame or
  // hand back a sibling's pixels. Activate first; best-effort. A visible user-driven tab is never raised, so it must already be showing.
  await preparePageForScreenshot(page, signal, config.activate);
  const effective: ScreenshotOptions = opts.selector ? { ...opts, fullPage: false } : opts;
  const { region, dpr } = await measure(target, effective, signal);
  const clip = { x: region.x, y: region.y, width: Math.max(1, Math.ceil(region.width)), height: Math.max(1, Math.ceil(region.height)) };
  const format = config.excludeWebP ? "jpeg" : "webp";
  const mimeType = config.excludeWebP ? "image/jpeg" : "image/webp";
  const ratio = modelPixelRatio(region, dpr);

  const capture = async (type: "png" | "webp" | "jpeg", quality: number | undefined, pixelsPerCss: number): Promise<Uint8Array> =>
    (await untilAborted(signal, () =>
      page.screenshot({
        type,
        ...(quality === undefined ? {} : { quality }),
        captureBeyondViewport: !region.inView,
        // The output is the clip's size times its scale times the page's own pixel ratio.
        clip: { ...clip, scale: pixelsPerCss / dpr },
      }),
    )) as Uint8Array;

  // The model's picture: the first encoding that fits the byte budget, walking OMP's quality then size ladder; the smallest one if none does.
  let best: { bytes: Uint8Array; ratio: number } | undefined;
  const attempt = async (pixelsPerCss: number, quality: number): Promise<boolean> => {
    const bytes = await capture(format, quality, pixelsPerCss);
    if (!best || bytes.length < best.bytes.length) best = { bytes, ratio: pixelsPerCss };
    return bytes.length <= MODEL_SHOT_MAX_BYTES;
  };
  let fits = await attempt(ratio, MODEL_SHOT_QUALITY);
  for (const quality of QUALITY_STEPS) {
    if (fits) break;
    fits = await attempt(ratio, quality);
  }
  for (const scale of SCALE_STEPS) {
    if (fits) break;
    if (clip.width * ratio * scale < 100 || clip.height * ratio * scale < 100) break;
    for (const quality of [MODEL_SHOT_QUALITY, ...QUALITY_STEPS]) {
      fits = await attempt(ratio * scale, quality);
      if (fits) break;
    }
  }
  const modelBytes = best!.bytes;
  const dims = readImageDimensions(modelBytes);
  const width = dims?.width ?? Math.round(clip.width * best!.ratio);
  const height = dims?.height ?? Math.round(clip.height * best!.ratio);
  const resized: ShotInfo = {
    mimeType,
    bytes: modelBytes.length,
    width,
    height,
    originalWidth: Math.round(clip.width * dpr),
    originalHeight: Math.round(clip.height * dpr),
  };

  const saveFullRes = !!config.dir;
  const saved = saveFullRes ? await capture("png", undefined, dpr) : modelBytes;
  const savedMimeType = saveFullRes ? "image/png" : mimeType;
  const ext = extensionOf(savedMimeType);
  const dest = config.dir
    ? path.join(config.dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1)}.${ext}`)
    : path.join(os.tmpdir(), `dimension-sshots-${crypto.randomUUID()}.${ext}`);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, saved);
  screenshots.push({ dest, mimeType: savedMimeType, bytes: saved.length, width, height });
  if (!opts.silent) {
    const lines = formatScreenshot({ saveFullRes, savedMimeType, savedByteLength: saved.length, dest, resized });
    output.push({ type: "text", text: lines.join("\n") });
    const image: ImageBlock = { type: "image", data: Buffer.from(modelBytes).toString("base64"), mimeType };
    output.push(image satisfies RunResult["displays"][number]);
  }
  return dest;
}
