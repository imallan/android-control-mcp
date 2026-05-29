import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type ToolResult = Record<string, unknown>;

type Bounds = [number, number, number, number];

type OcrMode = "auto" | "force" | "off";

type OcrEngine = "tesseract" | "apple-vision";

type SemanticNode = {
  id: string;
  ref?: string;
  text?: string;
  contentDesc?: string;
  resourceId?: string;
  className?: string;
  role?: string;
  bounds: Bounds;
  center: [number, number];
  clickable?: boolean;
  scrollable?: boolean;
  editable?: boolean;
  actions?: string[];
  source: "accessibility" | "ocr";
  confidence?: number;
  score?: number;
};

type SemanticSnapshot = {
  snapshotId: string;
  screenSignature: string;
  packageName?: string;
  width?: number;
  height?: number;
  nodes: SemanticNode[];
  nodeCount: number;
};

type SnapshotCacheEntry = SemanticSnapshot & {
  createdAtMs: number;
};

type ScreenshotResult = ToolResult & {
  imagePath: string;
  width: number;
  height: number;
  retained: boolean;
};

type OcrWord = {
  text: string;
  confidence: number;
  bounds: Bounds;
  lineKey: string;
};

type AndroidApp = {
  applicationId: string;
  activityName: string;
  componentName: string;
  name: string;
  labelSource: "packageManager" | "derived";
  aliases: string[];
};

type NodeSelector = {
  text?: string;
  contentDesc?: string;
  resourceId?: string;
  className?: string;
  bounds?: string;
  occurrence?: number;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<ToolResult>;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.ANDROID_MCP_ADB_TIMEOUT_MS ?? 15_000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.ANDROID_MCP_SCREENSHOT_TIMEOUT_MS ?? 20_000);
const OCR_TIMEOUT_MS = Number(process.env.ANDROID_MCP_OCR_TIMEOUT_MS ?? 90_000);
const BRIDGE_HOST = process.env.ANDROID_UI_MCP_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.ANDROID_UI_MCP_PORT ?? 27_183);
const BRIDGE_TIMEOUT_MS = Number(process.env.ANDROID_UI_MCP_TIMEOUT_MS ?? 15_000);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const APPLE_VISION_OCR_SOURCE = join(MODULE_DIR, "..", "apple-vision-ocr.swift");
const APPLE_VISION_OCR_BIN = process.env.ANDROID_MCP_APPLE_VISION_OCR_BIN ?? join(tmpdir(), "android-ui-mcp", "apple-vision-ocr");
const CLANG_MODULE_CACHE_DIR = join(tmpdir(), "android-ui-mcp", "clang-module-cache");
const SNAPSHOT_CACHE_LIMIT = 20;

const snapshotCache = new Map<string, SnapshotCacheEntry>();

const KEYCODES: Record<string, string> = {
  BACK: "KEYCODE_BACK",
  HOME: "KEYCODE_HOME",
  ENTER: "KEYCODE_ENTER",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
  DEL: "KEYCODE_DEL"
};

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

class AdbCommandError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "AdbCommandError";
    this.details = details;
  }
}

class AndroidBridgeError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "AndroidBridgeError";
    this.details = details;
  }
}

function adbBaseArgs(): string[] {
  const serial = process.env.ANDROID_SERIAL;
  return serial ? ["-s", serial] : [];
}

async function adbBuffer(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("adb", [...adbBaseArgs(), ...args], {
      encoding: "buffer",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    throw normalizeAdbError(args, error);
  }
}

async function adbText(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync("adb", [...adbBaseArgs(), ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw normalizeAdbError(args, error);
  }
}

async function androidBridgeRpc(method: string, params: Record<string, string | number | boolean> = {}): Promise<Record<string, unknown>> {
  await ensureAndroidBridgeForward();

  const start = performance.now();
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection({ host: BRIDGE_HOST, port: BRIDGE_PORT });
    let buffer = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    function settle(error: Error | undefined, value?: Record<string, unknown>): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value ?? {});
      }
    }

    timeout = setTimeout(() => {
      settle(
        new AndroidBridgeError("Android bridge request timed out.", {
          method,
          host: BRIDGE_HOST,
          port: BRIDGE_PORT,
          timeoutMs: BRIDGE_TIMEOUT_MS,
          hint: "Start android-server/scripts/start-uiautomator-server.sh and confirm adb forward is active."
        })
      );
    }, BRIDGE_TIMEOUT_MS);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ method, ...params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      try {
        settle(undefined, JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        settle(error as Error);
      }
    });
    socket.on("error", (error) => {
      settle(
        new AndroidBridgeError(`Android bridge connection failed: ${error.message}`, {
          method,
          host: BRIDGE_HOST,
          port: BRIDGE_PORT,
          hint: "Start android-server/scripts/start-uiautomator-server.sh. The MCP server talks to that process through adb forward."
        })
      );
    });
  });

  response.hostElapsedMs = Math.round(performance.now() - start);
  if (response.ok !== true) {
    throw new AndroidBridgeError(`Android bridge ${method} failed.`, { method, response });
  }
  return response;
}

async function ensureAndroidBridgeForward(): Promise<void> {
  await adbText(["forward", `tcp:${BRIDGE_PORT}`, "localabstract:android-ui-mcp"]);
}

function normalizeAdbError(args: string[], error: unknown): AdbCommandError {
  const err = error as NodeJS.ErrnoException & {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    code?: string | number;
    signal?: string;
    killed?: boolean;
  };
  const stdout = bufferishToString(err.stdout);
  const stderr = bufferishToString(err.stderr);
  const hint = adbHint(stdout, stderr, err);

  return new AdbCommandError(`adb ${args.join(" ")} failed${hint ? `: ${hint}` : ""}`, {
    command: ["adb", ...adbBaseArgs(), ...args].join(" "),
    code: err.code,
    signal: err.signal,
    killed: err.killed,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    hint
  });
}

function bufferishToString(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return "";
  }
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function adbHint(stdout: string, stderr: string, err: { code?: string | number; killed?: boolean }): string {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (err.killed) {
    return "ADB command timed out; check that the device is responsive.";
  }
  if (combined.includes("more than one device")) {
    return "Multiple devices are connected; set ANDROID_SERIAL to select one.";
  }
  if (combined.includes("no devices") || combined.includes("device not found")) {
    return "No Android device is connected or authorized.";
  }
  if (combined.includes("unauthorized")) {
    return "The Android device has not authorized this computer for ADB.";
  }
  if (combined.includes("closed")) {
    return "ADB connection closed; reconnect the device or restart adb server.";
  }
  if (combined.includes("smartsocket") && combined.includes("operation not permitted")) {
    return "ADB could not start its local daemon in this environment; allow adb server access or start adb outside the sandbox.";
  }
  return "";
}

function truncate(value: string, limit = 2_000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}...`;
}

function expectObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolInputError("Input must be an object.");
  }
  return input as Record<string, unknown>;
}

function optionalObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) {
    return {};
  }
  return expectObject(input);
}

function numberParam(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ToolInputError(`${name} must be a non-negative integer.`);
  }
  return value as number;
}

function optionalIntegerParam(input: Record<string, unknown>, name: string, defaultValue: number): number {
  const value = input[name];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ToolInputError(`${name} must be a non-negative integer when provided.`);
  }
  return value as number;
}

function positiveNumberParam(input: Record<string, unknown>, name: string): number {
  const value = numberParam(input, name);
  if (value < 1) {
    throw new ToolInputError(`${name} must be a positive integer.`);
  }
  return value;
}

function stringParam(input: Record<string, unknown>, name: string): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${name} must be a non-empty string.`);
  }
  return value;
}

function optionalStringParam(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${name} must be a non-empty string when provided.`);
  }
  return value;
}

function optionalEnumParam<T extends string>(input: Record<string, unknown>, name: string, values: readonly T[], defaultValue: T): T {
  const value = input[name];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ToolInputError(`${name} must be one of: ${values.join(", ")}.`);
  }
  return value as T;
}

function optionalRoiParam(input: Record<string, unknown>, name: string): Bounds | undefined {
  const value = input[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 4 || !value.every((item) => Number.isInteger(item) && item >= 0)) {
    throw new ToolInputError(`${name} must be [x1, y1, x2, y2] with non-negative integers.`);
  }
  const roi = value as Bounds;
  if (roi[2] <= roi[0] || roi[3] <= roi[1]) {
    throw new ToolInputError(`${name} must have x2 > x1 and y2 > y1.`);
  }
  return roi;
}

function optionalBooleanParam(input: Record<string, unknown>, name: string, defaultValue: boolean): boolean {
  const value = input[name];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new ToolInputError(`${name} must be a boolean when provided.`);
  }
  return value;
}

function optionalSelectorParam(input: Record<string, unknown>, name: string): NodeSelector | undefined {
  const value = input[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  const selector = expectObject(value);
  const occurrenceValue = selector.occurrence;
  if (occurrenceValue !== undefined && (!Number.isInteger(occurrenceValue) || (occurrenceValue as number) < 1)) {
    throw new ToolInputError("selector.occurrence must be a positive integer when provided.");
  }
  return {
    text: optionalStringParam(selector, "text"),
    contentDesc: optionalStringParam(selector, "contentDesc"),
    resourceId: optionalStringParam(selector, "resourceId"),
    className: optionalStringParam(selector, "className"),
    bounds: optionalStringParam(selector, "bounds"),
    occurrence: occurrenceValue as number | undefined
  };
}

function selectorHasAnyField(selector: NodeSelector): boolean {
  return Boolean(selector.text || selector.contentDesc || selector.resourceId || selector.className || selector.bounds);
}

function flattenSelector(selector: NodeSelector): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (selector.text !== undefined) {
    params.targetText = selector.text;
  }
  if (selector.contentDesc !== undefined) {
    params.targetContentDesc = selector.contentDesc;
  }
  if (selector.resourceId !== undefined) {
    params.targetResourceId = selector.resourceId;
  }
  if (selector.className !== undefined) {
    params.targetClassName = selector.className;
  }
  if (selector.bounds !== undefined) {
    params.targetBounds = selector.bounds;
  }
  if (selector.occurrence !== undefined) {
    params.targetOccurrence = selector.occurrence;
  }
  return params;
}

function parsePngSize(png: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  if (png.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("screencap did not return a valid PNG.");
  }
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  };
}

async function androidScreenshot(input: unknown): Promise<ScreenshotResult> {
  const params = optionalObject(input);
  const retain = optionalBooleanParam(params, "retain", false);
  const png = await adbBuffer(["exec-out", "screencap", "-p"], SCREENSHOT_TIMEOUT_MS);
  const { width, height } = parsePngSize(png);
  const dir = retain ? await mkdtemp(join(tmpdir(), "android-ui-mcp-")) : join(tmpdir(), "android-ui-mcp");
  if (!retain) {
    await mkdir(dir, { recursive: true });
  }
  const imagePath = join(dir, "current-screen.png");
  await writeFile(imagePath, png);
  return { imagePath, width, height, retained: retain };
}

async function androidOcrScreen(input: unknown): Promise<ToolResult> {
  const options = ocrOptions(input);
  const screenshot = await androidScreenshot({ retain: options.retain });
  const ocr = await runOcr(screenshot, options);
  return {
    ...screenshot,
    roi: options.roi,
    langs: options.langs,
    minConfidence: options.minConfidence,
    ocrEngine: options.ocrEngine,
    nodes: ocr.nodes.slice(0, options.maxNodes),
    nodeCount: Math.min(ocr.nodes.length, options.maxNodes),
    totalNodeCount: ocr.nodes.length,
    ocrElapsedMs: ocr.elapsedMs,
    ...(options.includeRawOcr ? { rawOcr: ocr.rawOcr } : {})
  };
}

async function androidGetSemanticScreen(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const options = ocrOptions(params);
  const ocrMode = optionalEnumParam(params, "ocrMode", ["auto", "force", "off"] as const, "auto");
  const includeScreenshot = optionalBooleanParam(params, "includeScreenshot", true);
  const includeRawTree = optionalBooleanParam(params, "includeRawTree", false);

  const [screenshot, compact] = await Promise.all([androidScreenshot({ retain: options.retain }), androidDumpCompact()]);
  const accessibilityNodes = compactNodes(compact);
  const tree = assessTreeUsability(compact, accessibilityNodes);
  const shouldRunOcr = ocrMode === "force" || (ocrMode === "auto" && !tree.usable);
  const ocr = shouldRunOcr ? await runOcr(screenshot, options) : undefined;
  const nodes = mergeSemanticNodes(accessibilityNodes, ocr?.nodes ?? [], options.maxNodes);
  const snapshot = createSemanticSnapshot(compact, nodes);
  rememberSnapshot(snapshot);

  return {
    ...(includeScreenshot ? screenshot : {}),
    snapshotId: snapshot.snapshotId,
    screenSignature: snapshot.screenSignature,
    packageName: compact.packageName,
    width: includeScreenshot ? screenshot.width : compact.width,
    height: includeScreenshot ? screenshot.height : compact.height,
    ocrMode,
    ocrUsed: shouldRunOcr,
    ocrEngine: shouldRunOcr ? options.ocrEngine : undefined,
    ocrReason: shouldRunOcr ? (ocrMode === "force" ? "forced" : tree.reason) : "not_needed",
    treeUsable: tree.usable,
    accessibilityNodeCount: accessibilityNodes.length,
    ocrNodeCount: ocr?.nodes.length ?? 0,
    nodes: snapshot.nodes,
    nodeCount: snapshot.nodeCount,
    ...(includeRawTree ? { compactTree: compact } : {}),
    ...(options.includeRawOcr && ocr ? { rawOcr: ocr.rawOcr } : {})
  };
}

function ocrOptions(input: unknown): {
  roi?: Bounds;
  langs: string;
  ocrEngine: OcrEngine;
  maxNodes: number;
  minConfidence: number;
  retain: boolean;
  includeRawOcr: boolean;
} {
  const params = optionalObject(input);
  const langs = optionalStringParam(params, "langs") ?? "chi_sim+eng";
  const ocrEngine = optionalEnumParam(params, "ocrEngine", ["tesseract", "apple-vision"] as const, "apple-vision");
  const maxNodes = Math.max(1, optionalIntegerParam(params, "maxNodes", 80));
  const minConfidence = Math.min(100, optionalIntegerParam(params, "minConfidence", 45));
  return {
    roi: optionalRoiParam(params, "roi"),
    langs,
    ocrEngine,
    maxNodes,
    minConfidence,
    retain: optionalBooleanParam(params, "retain", false),
    includeRawOcr: optionalBooleanParam(params, "includeRawOcr", false)
  };
}

async function runOcr(
  screenshot: ScreenshotResult,
  options: { roi?: Bounds; langs: string; ocrEngine: OcrEngine; minConfidence: number }
): Promise<{ nodes: SemanticNode[]; rawOcr: string; elapsedMs: number }> {
  const start = performance.now();
  const target = options.roi ? await cropImage(screenshot, options.roi) : { imagePath: screenshot.imagePath, offsetX: 0, offsetY: 0 };
  const result =
    options.ocrEngine === "apple-vision"
      ? await runAppleVisionOcr(target.imagePath, options.langs, options.minConfidence, target.offsetX, target.offsetY)
      : await runTesseractOcr(target.imagePath, options.langs, options.minConfidence, target.offsetX, target.offsetY);
  return {
    nodes: result.nodes,
    rawOcr: result.rawOcr,
    elapsedMs: Math.round(performance.now() - start)
  };
}

async function runTesseractOcr(
  imagePath: string,
  langs: string,
  minConfidence: number,
  offsetX: number,
  offsetY: number
): Promise<{ nodes: SemanticNode[]; rawOcr: string }> {
  const rawOcr = await execText("tesseract", [imagePath, "stdout", "-l", langs, "--psm", "6", "tsv"], OCR_TIMEOUT_MS);
  const words = parseTesseractTsv(rawOcr, minConfidence, offsetX, offsetY);
  return { nodes: mergeOcrWords(words), rawOcr };
}

async function runAppleVisionOcr(
  imagePath: string,
  langs: string,
  minConfidence: number,
  offsetX: number,
  offsetY: number
): Promise<{ nodes: SemanticNode[]; rawOcr: string }> {
  const bin = await ensureAppleVisionOcrBin();
  const visionLangs = appleVisionLanguages(langs).join(",");
  const rawOcr = await execText(bin, [imagePath, "--langs", visionLangs], OCR_TIMEOUT_MS);
  return { nodes: parseAppleVisionOcr(rawOcr, minConfidence, offsetX, offsetY), rawOcr };
}

async function ensureAppleVisionOcrBin(): Promise<string> {
  try {
    await access(APPLE_VISION_OCR_BIN);
    return APPLE_VISION_OCR_BIN;
  } catch {
    await mkdir(dirname(APPLE_VISION_OCR_BIN), { recursive: true });
    await mkdir(CLANG_MODULE_CACHE_DIR, { recursive: true });
    await execText("swiftc", [APPLE_VISION_OCR_SOURCE, "-o", APPLE_VISION_OCR_BIN], OCR_TIMEOUT_MS);
    return APPLE_VISION_OCR_BIN;
  }
}

function appleVisionLanguages(langs: string): string[] {
  const requested = langs
    .split(/[+,]/)
    .map((lang) => lang.trim())
    .filter(Boolean);
  const mapped = requested.map((lang) => {
      switch (lang) {
        case "chi_sim":
        case "zh":
        case "zh_CN":
        case "zh-CN":
          return "zh-Hans";
        case "chi_tra":
        case "zh_TW":
        case "zh-TW":
          return "zh-Hant";
        case "eng":
        case "en":
          return "en-US";
        default:
          return lang;
      }
    });
  if (requested.some((lang) => ["chi_sim", "zh", "zh_CN", "zh-CN", "zh-Hans"].includes(lang))) {
    return ["zh-Hans"];
  }
  if (requested.some((lang) => ["chi_tra", "zh_TW", "zh-TW", "zh-Hant"].includes(lang))) {
    return ["zh-Hant"];
  }
  return mapped.length > 0 ? Array.from(new Set(mapped)) : ["zh-Hans", "en-US"];
}

function parseAppleVisionOcr(rawOcr: string, minConfidence: number, offsetX: number, offsetY: number): SemanticNode[] {
  const parsed = expectObject(JSON.parse(rawOcr));
  const rawNodes = parsed.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new Error("Apple Vision OCR output did not include nodes.");
  }

  const nodes: SemanticNode[] = [];
  for (const [index, rawNode] of rawNodes.entries()) {
    const node = expectObject(rawNode);
    const text = optionalStringParam(node, "text");
    const confidence = numberParam(node, "confidence");
    const rawBounds = node.bounds;
    if (!text || confidence < minConfidence || !isUsefulOcrText(text)) {
      continue;
    }
    if (!Array.isArray(rawBounds) || rawBounds.length !== 4 || !rawBounds.every((value) => Number.isInteger(value) && value >= 0)) {
      continue;
    }
    const bounds: Bounds = [
      (rawBounds[0] as number) + offsetX,
      (rawBounds[1] as number) + offsetY,
      (rawBounds[2] as number) + offsetX,
      (rawBounds[3] as number) + offsetY
    ];
    nodes.push({
      id: `ocr:${index + 1}`,
      text: truncate(text, 80),
      bounds,
      center: boundsCenter(bounds),
      clickable: true,
      source: "ocr",
      confidence
    });
  }

  return dedupeSemanticNodes(nodes).sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
}

async function cropImage(screenshot: ScreenshotResult, roi: Bounds): Promise<{ imagePath: string; offsetX: number; offsetY: number }> {
  if (roi[0] === 0 && roi[1] === 0 && roi[2] >= screenshot.width && roi[3] >= screenshot.height) {
    return { imagePath: screenshot.imagePath, offsetX: 0, offsetY: 0 };
  }

  let x1 = Math.min(roi[0], screenshot.width - 1);
  let y1 = Math.min(roi[1], screenshot.height - 1);
  const x2 = Math.min(roi[2], screenshot.width);
  const y2 = Math.min(roi[3], screenshot.height);
  let width = x2 - x1;
  let height = y2 - y1;
  if (width <= 0 || height <= 0) {
    throw new ToolInputError("roi falls outside the screenshot bounds.");
  }

  // sips may skip cropping when the crop offset lands exactly on the bottom/right edge.
  // Shift the crop inward by one pixel in that case; the OCR coordinate offset remains
  // accurate enough for click-center estimation.
  if (x1 > 0 && x1 + width >= screenshot.width) {
    x1 = Math.max(0, screenshot.width - width - 1);
  }
  if (y1 > 0 && y1 + height >= screenshot.height) {
    y1 = Math.max(0, screenshot.height - height - 1);
  }

  const dir = screenshot.retained ? await mkdtemp(join(tmpdir(), "android-ui-mcp-ocr-")) : join(tmpdir(), "android-ui-mcp");
  await mkdir(dir, { recursive: true });
  const cropPath = join(dir, "ocr-crop.png");
  await execText("sips", ["-c", String(height), String(width), "--cropOffset", String(y1), String(x1), screenshot.imagePath, "--out", cropPath], DEFAULT_TIMEOUT_MS);
  await stat(cropPath);
  return { imagePath: cropPath, offsetX: x1, offsetY: y1 };
}

async function execText(command: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: CLANG_MODULE_CACHE_DIR },
      maxBuffer: 32 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer; code?: string | number; killed?: boolean };
    throw new Error(
      `${command} ${args.join(" ")} failed${err.killed ? " because it timed out" : ""}: ${truncate(bufferishToString(err.stderr) || bufferishToString(err.stdout))}`
    );
  }
}

function parseTesseractTsv(tsv: string, minConfidence: number, offsetX: number, offsetY: number): OcrWord[] {
  const lines = tsv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return [];
  }

  const headers = lines[0].split("\t");
  const indexes = {
    block: headers.indexOf("block_num"),
    paragraph: headers.indexOf("par_num"),
    line: headers.indexOf("line_num"),
    word: headers.indexOf("word_num"),
    left: headers.indexOf("left"),
    top: headers.indexOf("top"),
    width: headers.indexOf("width"),
    height: headers.indexOf("height"),
    confidence: headers.indexOf("conf"),
    text: headers.indexOf("text")
  };
  if (Object.values(indexes).some((index) => index < 0)) {
    throw new Error("Tesseract TSV output is missing expected columns.");
  }

  const words: OcrWord[] = [];
  for (const line of lines.slice(1)) {
    const columns = line.split("\t");
    const text = columns.slice(indexes.text).join("\t").trim();
    const confidence = Number(columns[indexes.confidence]);
    if (!Number.isFinite(confidence) || confidence < minConfidence || !isUsefulOcrText(text)) {
      continue;
    }
    const left = Number(columns[indexes.left]) + offsetX;
    const top = Number(columns[indexes.top]) + offsetY;
    const width = Number(columns[indexes.width]);
    const height = Number(columns[indexes.height]);
    if (![left, top, width, height].every(Number.isFinite) || width < 2 || height < 2) {
      continue;
    }

    words.push({
      text,
      confidence,
      bounds: [left, top, left + width, top + height],
      lineKey: `${columns[indexes.block]}:${columns[indexes.paragraph]}:${columns[indexes.line]}`
    });
  }
  return words;
}

function isUsefulOcrText(text: string): boolean {
  if (text.length === 0 || text.length > 160) {
    return false;
  }
  return /[\p{L}\p{N}]/u.test(text);
}

function mergeOcrWords(words: OcrWord[]): SemanticNode[] {
  const groups = new Map<string, OcrWord[]>();
  for (const word of words) {
    const group = groups.get(word.lineKey) ?? [];
    group.push(word);
    groups.set(word.lineKey, group);
  }

  const nodes: SemanticNode[] = [];
  let index = 0;
  for (const group of groups.values()) {
    const sorted = group.sort((a, b) => a.bounds[0] - b.bounds[0]);
    const text = sorted.map((word) => word.text).join(needsWordSpacing(sorted) ? " " : "").trim();
    if (!isUsefulOcrText(text)) {
      continue;
    }
    const bounds = unionBounds(sorted.map((word) => word.bounds));
    const confidence = Math.round(sorted.reduce((sum, word) => sum + word.confidence, 0) / sorted.length);
    nodes.push({
      id: `ocr:${++index}`,
      text: truncate(text, 80),
      bounds,
      center: boundsCenter(bounds),
      clickable: true,
      source: "ocr",
      confidence
    });
  }

  return dedupeSemanticNodes(nodes).sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);
}

function needsWordSpacing(words: OcrWord[]): boolean {
  return words.some((word) => /[A-Za-z0-9]/.test(word.text));
}

function compactNodes(compact: Record<string, unknown>): SemanticNode[] {
  const rawNodes = compact.nodes;
  if (!Array.isArray(rawNodes)) {
    return [];
  }
  const nodes: SemanticNode[] = [];
  for (const [index, rawNode] of rawNodes.entries()) {
    const node = expectObject(rawNode);
    const boundsValue = optionalStringParam(node, "bounds");
    const bounds = boundsValue ? parseBounds(boundsValue) : undefined;
    if (!bounds) {
      continue;
    }
    const text = optionalStringParam(node, "text");
    const contentDesc = optionalStringParam(node, "contentDesc");
    const resourceId = optionalStringParam(node, "resourceId");
    const className = optionalStringParam(node, "className");
    const actions = Array.isArray(node.actions) ? node.actions.filter((action): action is string => typeof action === "string") : undefined;
    nodes.push({
      id: `accessibility:${index + 1}`,
      ...(text ? { text: truncate(text, 80) } : {}),
      ...(contentDesc ? { contentDesc: truncate(contentDesc, 80) } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(className ? { className } : {}),
      bounds,
      center: boundsCenter(bounds),
      ...(node.clickable === true ? { clickable: true } : {}),
      ...(node.scrollable === true ? { scrollable: true } : {}),
      ...(actions && actions.length > 0 ? { actions } : {}),
      source: "accessibility"
    });
  }
  return nodes;
}

function assessTreeUsability(compact: Record<string, unknown>, nodes: SemanticNode[]): { usable: boolean; reason: string } {
  const packageName = typeof compact.packageName === "string" ? compact.packageName : "";
  if (["com.tencent.mm"].includes(packageName)) {
    return { usable: false, reason: "known_sparse_accessibility_app" };
  }
  if (nodes.length === 0) {
    return { usable: false, reason: "no_accessibility_nodes" };
  }

  const readableOrActionable = nodes.filter(
    (node) => node.text || node.contentDesc || node.clickable || node.scrollable || (node.actions && node.actions.length > 0)
  );
  const readable = nodes.filter((node) => node.text || node.contentDesc);
  if (readable.length < 3) {
    return { usable: false, reason: "sparse_tree" };
  }
  if (readableOrActionable.length === 0) {
    return { usable: false, reason: "no_readable_or_actionable_nodes" };
  }
  return { usable: true, reason: "tree_usable" };
}

function mergeSemanticNodes(accessibilityNodes: SemanticNode[], ocrNodes: SemanticNode[], maxNodes: number): SemanticNode[] {
  const merged = dedupeSemanticNodes([...accessibilityNodes, ...ocrNodes]);
  return assignSnapshotRefs(rankSemanticNodes(merged).slice(0, maxNodes));
}

function dedupeSemanticNodes(nodes: SemanticNode[]): SemanticNode[] {
  const result: SemanticNode[] = [];
  for (const node of nodes) {
    const text = (node.text ?? node.contentDesc ?? "").trim().toLowerCase();
    const duplicate = result.some((existing) => {
      const existingText = (existing.text ?? existing.contentDesc ?? "").trim().toLowerCase();
      return text.length > 0 && text === existingText && boundsOverlapRatio(node.bounds, existing.bounds) > 0.75;
    });
    if (!duplicate) {
      result.push(node);
    }
  }
  return result;
}

function rankSemanticNodes(nodes: SemanticNode[]): SemanticNode[] {
  return nodes
    .map((node) => {
      const role = inferNodeRole(node);
      const editable = isNodeEditable(node, role);
      const scoredNode = { ...node, ...(role ? { role } : {}), editable };
      return { ...scoredNode, score: scoreSemanticNode(scoredNode) };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0] || sourceRank(a.source) - sourceRank(b.source));
}

function assignSnapshotRefs(nodes: SemanticNode[]): SemanticNode[] {
  let accessibilityIndex = 0;
  let ocrIndex = 0;
  return nodes.map((node) => ({
    ...node,
    ref: node.source === "accessibility" ? `a${++accessibilityIndex}` : `o${++ocrIndex}`
  }));
}

function inferNodeRole(node: SemanticNode): string | undefined {
  const className = node.className ?? "";
  if (isNodeEditable(node)) {
    return "textbox";
  }
  if (className.includes("CheckBox")) {
    return "checkbox";
  }
  if (className.includes("Switch")) {
    return "switch";
  }
  if (className.includes("Button") || (node.clickable && Boolean(node.text || node.contentDesc))) {
    return "button";
  }
  if (node.scrollable) {
    return "scrollable";
  }
  if (node.text || node.contentDesc || node.source === "ocr") {
    return "text";
  }
  return undefined;
}

function isNodeEditable(node: SemanticNode, role?: string): boolean {
  return role === "textbox" || (node.className ?? "").includes("EditText") || actionNames(node).includes("set_text");
}

function scoreSemanticNode(node: SemanticNode): number {
  let score = node.source === "accessibility" ? 0.4 : 0.2;
  if (node.editable) {
    score += 0.5;
  }
  if (node.clickable) {
    score += 0.3;
  }
  if (node.scrollable) {
    score += 0.18;
  }
  if (node.resourceId) {
    score += 0.12;
  }
  if (node.contentDesc) {
    score += 0.1;
  }
  if (node.text) {
    score += 0.08;
  }
  if (node.role === "button" || node.role === "checkbox" || node.role === "switch") {
    score += 0.12;
  }
  if (node.role === "text" && node.source === "ocr") {
    score += 0.05;
  }
  return Math.min(1, Number(score.toFixed(3)));
}

function actionNames(node: SemanticNode): string[] {
  return (node.actions ?? []).map((action) => action.toLowerCase());
}

function sourceRank(source: SemanticNode["source"]): number {
  return source === "accessibility" ? 0 : 1;
}

function createSemanticSnapshot(compact: Record<string, unknown>, nodes: SemanticNode[]): SemanticSnapshot {
  const screenSignature = createScreenSignature(compact, nodes);
  return {
    snapshotId: createSnapshotId(screenSignature),
    screenSignature,
    packageName: typeof compact.packageName === "string" ? compact.packageName : undefined,
    width: typeof compact.width === "number" ? compact.width : undefined,
    height: typeof compact.height === "number" ? compact.height : undefined,
    nodes,
    nodeCount: nodes.length
  };
}

function rememberSnapshot(snapshot: SemanticSnapshot): void {
  snapshotCache.set(snapshot.snapshotId, { ...snapshot, createdAtMs: Date.now() });
  while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldestKey = snapshotCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    snapshotCache.delete(oldestKey);
  }
}

function currentAccessibilitySnapshot(): Promise<SemanticSnapshot> {
  return androidDumpCompact().then((compact) => {
    const nodes = mergeSemanticNodes(compactNodes(compact), [], 80);
    const snapshot = createSemanticSnapshot(compact, nodes);
    rememberSnapshot(snapshot);
    return snapshot;
  });
}

function createScreenSignature(compact: Record<string, unknown>, nodes: SemanticNode[]): string {
  const packageName = typeof compact.packageName === "string" ? compact.packageName : "";
  const width = typeof compact.width === "number" ? compact.width : "";
  const height = typeof compact.height === "number" ? compact.height : "";
  const signature = JSON.stringify({
    packageName,
    width,
    height,
    nodes: nodes
      .filter((node) => node.source === "accessibility")
      .map((node) => ({
        role: node.role,
        text: node.text,
        contentDesc: node.contentDesc,
        resourceId: node.resourceId,
        className: node.className,
        bounds: node.bounds,
        clickable: node.clickable === true,
        scrollable: node.scrollable === true,
        editable: node.editable === true
      }))
  });
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

function createSnapshotId(screenSignature: string): string {
  return `screen:${Date.now()}:${screenSignature.slice(0, 10)}`;
}

function relocateAccessibilityNode(
  original: SemanticNode,
  currentNodes: SemanticNode[]
): { node?: SemanticNode; status: "stale_ref_not_found" | "stale_ref_ambiguous"; message: string; candidates?: Record<string, unknown>[] } {
  const candidates = currentNodes.filter((node) => node.source === "accessibility");
  const strategies: Array<{ name: string; matches: SemanticNode[] }> = [
    {
      name: "resourceId_role",
      matches:
        original.resourceId && original.role
          ? candidates.filter((node) => node.resourceId === original.resourceId && node.role === original.role)
          : []
    },
    {
      name: "contentDesc_role",
      matches:
        original.contentDesc && original.role
          ? candidates.filter((node) => node.contentDesc === original.contentDesc && node.role === original.role)
          : []
    },
    {
      name: "text_role",
      matches: original.text && original.role ? candidates.filter((node) => node.text === original.text && node.role === original.role) : []
    },
    {
      name: "label_class_bounds",
      matches: candidates.filter(
        (node) =>
          samePrimaryLabel(original, node) &&
          Boolean(original.className) &&
          node.className === original.className &&
          boundsAreNear(original.bounds, node.bounds)
      )
    }
  ];

  for (const strategy of strategies) {
    if (strategy.matches.length === 1) {
      return { node: strategy.matches[0], status: "stale_ref_not_found", message: `Relocated by ${strategy.name}.` };
    }
    if (strategy.matches.length > 1) {
      return {
        status: "stale_ref_ambiguous",
        message: `The original ref is stale and ${strategy.matches.length} current accessibility nodes match ${strategy.name}.`,
        candidates: strategy.matches.slice(0, 10).map((node) => nodeRefSummary(undefined, node))
      };
    }
  }

  return {
    status: "stale_ref_not_found",
    message: "The original ref is stale and no current accessibility node matched conservatively."
  };
}

function samePrimaryLabel(left: SemanticNode, right: SemanticNode): boolean {
  const leftLabel = left.text ?? left.contentDesc;
  const rightLabel = right.text ?? right.contentDesc;
  return Boolean(leftLabel && rightLabel && leftLabel === rightLabel);
}

function boundsAreNear(left: Bounds, right: Bounds): boolean {
  const leftCenter = boundsCenter(left);
  const rightCenter = boundsCenter(right);
  const dx = leftCenter[0] - rightCenter[0];
  const dy = leftCenter[1] - rightCenter[1];
  const distance = Math.sqrt(dx * dx + dy * dy);
  const leftWidth = Math.max(1, left[2] - left[0]);
  const leftHeight = Math.max(1, left[3] - left[1]);
  return distance <= Math.max(120, Math.max(leftWidth, leftHeight));
}

function nodeRefSummary(snapshotId: string | undefined, node: SemanticNode): Record<string, unknown> {
  return {
    ...(snapshotId ? { snapshotId } : {}),
    ref: node.ref,
    id: node.id,
    text: node.text,
    contentDesc: node.contentDesc,
    resourceId: node.resourceId,
    className: node.className,
    role: node.role,
    bounds: node.bounds,
    center: node.center,
    source: node.source
  };
}

function parseBounds(value: string): Bounds | undefined {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function unionBounds(bounds: Bounds[]): Bounds {
  return [
    Math.min(...bounds.map((bound) => bound[0])),
    Math.min(...bounds.map((bound) => bound[1])),
    Math.max(...bounds.map((bound) => bound[2])),
    Math.max(...bounds.map((bound) => bound[3]))
  ];
}

function boundsCenter(bounds: Bounds): [number, number] {
  return [Math.round((bounds[0] + bounds[2]) / 2), Math.round((bounds[1] + bounds[3]) / 2)];
}

function boundsOverlapRatio(left: Bounds, right: Bounds): number {
  const x1 = Math.max(left[0], right[0]);
  const y1 = Math.max(left[1], right[1]);
  const x2 = Math.min(left[2], right[2]);
  const y2 = Math.min(left[3], right[3]);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const leftArea = Math.max(1, (left[2] - left[0]) * (left[3] - left[1]));
  const rightArea = Math.max(1, (right[2] - right[0]) * (right[3] - right[1]));
  return overlap / Math.min(leftArea, rightArea);
}

async function androidDumpTree(): Promise<ToolResult> {
  const response = await androidBridgeRpc("dumpXml");
  const xml = response.xml;
  if (typeof xml !== "string") {
    throw new AndroidBridgeError("Android bridge dumpXml response did not include XML.", { response });
  }
  if (!xml.includes("<hierarchy")) {
    throw new Error("UIAutomator bridge did not return a hierarchy XML document.");
  }
  return response;
}

async function androidDumpCompact(): Promise<ToolResult> {
  return androidBridgeRpc("dumpCompact");
}

async function androidTap(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const x = numberParam(params, "x");
  const y = numberParam(params, "y");
  const response = await androidBridgeRpc("tap", { x, y });
  return normalizeBridgeSuccess(response);
}

async function androidTapRef(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const snapshotId = stringParam(params, "snapshotId");
  const ref = stringParam(params, "ref");
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const cached = snapshotCache.get(snapshotId);
  if (!cached) {
    return {
      success: false,
      status: "expired_snapshot",
      message: "The requested snapshotId is no longer cached. Call android_get_semantic_screen again.",
      snapshotId,
      ref
    };
  }

  const originalNode = cached.nodes.find((node) => node.ref === ref);
  if (!originalNode) {
    return {
      success: false,
      status: "ref_not_found",
      message: "The requested ref was not found in the cached snapshot.",
      snapshotId,
      ref
    };
  }
  if (originalNode.source !== "accessibility") {
    return {
      success: false,
      status: "unsupported_ref_source",
      message: "OCR refs are observation-only and cannot be tapped by ref in v1.",
      snapshotId,
      ref,
      source: originalNode.source
    };
  }

  const current = await currentAccessibilitySnapshot();
  const fresh = current.screenSignature === cached.screenSignature;
  const target = fresh ? { node: originalNode } : relocateAccessibilityNode(originalNode, current.nodes);
  if (!target.node) {
    return {
      success: false,
      status: target.status,
      message: target.message,
      from: nodeRefSummary(cached.snapshotId, originalNode),
      candidates: target.candidates,
      ...(returnSnapshot ? { currentSnapshot: current } : {})
    };
  }

  const [x, y] = target.node.center;
  const tapResult = normalizeBridgeSuccess(await androidBridgeRpc("tap", { x, y }));
  const afterSnapshot = returnSnapshot ? await currentAccessibilitySnapshot() : undefined;
  return {
    ...tapResult,
    status: fresh ? "fresh" : "relocated",
    actionStrategy: "coordinate_tap",
    from: nodeRefSummary(cached.snapshotId, originalNode),
    target: nodeRefSummary(fresh ? cached.snapshotId : current.snapshotId, target.node),
    ...(afterSnapshot ? { currentSnapshot: afterSnapshot } : {})
  };
}

async function androidSwipe(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const x1 = numberParam(params, "x1");
  const y1 = numberParam(params, "y1");
  const x2 = numberParam(params, "x2");
  const y2 = numberParam(params, "y2");
  const durationMs = params.durationMs === undefined ? 300 : numberParam(params, "durationMs");
  const steps = params.steps === undefined ? Math.max(1, Math.round(durationMs / 5)) : positiveNumberParam(params, "steps");
  const response = await androidBridgeRpc("swipe", { x1, y1, x2, y2, steps });
  return normalizeBridgeSuccess({ ...response, steps });
}

async function androidInputText(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const text = stringParam(params, "text");
  const selector = optionalSelectorParam(params, "selector");
  const pressEnter = optionalBooleanParam(params, "pressEnter", false);

  if (selector && selectorHasAnyField(selector)) {
    const response = await androidBridgeRpc("inputText", {
      text,
      ...flattenSelector(selector)
    });
    const result = normalizeBridgeSuccess(response);
    if (pressEnter) {
      await androidBridgeRpc("key", { key: "ENTER" });
    }
    return result;
  }

  const response = await androidBridgeRpc("inputText", { text });
  const result = normalizeBridgeSuccess(response);
  if (pressEnter) {
    await androidBridgeRpc("key", { key: "ENTER" });
  }
  return result;
}

async function androidPerformAction(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const action = stringParam(params, "action");
  const selector = optionalSelectorParam(params, "selector");
  if (!selector || !selectorHasAnyField(selector)) {
    throw new ToolInputError("selector is required and must identify a node.");
  }
  const response = await androidBridgeRpc("performAction", {
    action,
    ...flattenSelector(selector)
  });
  return normalizeBridgeSuccess(response);
}

async function androidLongPress(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const x = numberParam(params, "x");
  const y = numberParam(params, "y");
  const durationMs = params.durationMs === undefined ? 650 : numberParam(params, "durationMs");
  const steps = Math.max(1, Math.round(durationMs / 5));
  const response = await androidBridgeRpc("longPress", { x, y, steps });
  return normalizeBridgeSuccess({ ...response, durationMs, steps });
}

async function androidKey(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const key = stringParam(params, "key").toUpperCase();
  const keycode = KEYCODES[key];
  if (!keycode) {
    throw new ToolInputError(`key must be one of: ${Object.keys(KEYCODES).join(", ")}.`);
  }
  const response = await androidBridgeRpc("key", { key });
  return normalizeBridgeSuccess({ ...response, key, keycode });
}

async function androidBridgePing(input: unknown): Promise<ToolResult> {
  optionalObject(input);
  return androidBridgeRpc("ping");
}

async function androidBridgeExit(input: unknown): Promise<ToolResult> {
  optionalObject(input);
  return normalizeBridgeSuccess(await androidBridgeRpc("exit"));
}

function normalizeBridgeSuccess(response: Record<string, unknown>): ToolResult {
  return {
    ...response,
    success: response.success === true
  };
}

async function androidListApps(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const query = optionalStringParam(params, "query");
  const includeSystem = optionalBooleanParam(params, "includeSystem", true);
  optionalBooleanParam(params, "resolveLabels", false);
  const apps = await getLauncherApps();
  const filtered = apps.filter((app) => {
    if (!includeSystem && !isLikelyUserApp(app.applicationId)) {
      return false;
    }
    if (!query) {
      return true;
    }
    const needle = normalizeAppName(query);
    return searchableAppStrings(app).some((value) => normalizeAppName(value).includes(needle));
  });

  return {
    apps: filtered,
    count: filtered.length,
    localizationNote:
      "App names are derived on the Android device from package and launcher activity names. Use applicationId for deterministic launching."
  };
}

async function androidLaunchApp(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const applicationId = optionalStringParam(params, "applicationId");
  const appName = optionalStringParam(params, "appName");
  const allowSubstring = optionalBooleanParam(params, "allowSubstring", true);
  optionalBooleanParam(params, "resolveLabels", true);

  if (!applicationId && !appName) {
    throw new ToolInputError("Provide applicationId or appName.");
  }
  if (applicationId && appName) {
    throw new ToolInputError("Provide only one of applicationId or appName.");
  }

  const apps = await getLauncherApps();
  let target = applicationId ? findAppByApplicationId(apps, applicationId) : findAppByName(apps, appName as string, allowSubstring, false);
  if (!target) {
    throw new ToolInputError(
      `No launcher app matched appName '${appName}'. Call android_list_apps, then launch by applicationId.`
    );
  }
  const response = await androidBridgeRpc("launchApp", { applicationId: target.applicationId });
  const result = normalizeBridgeSuccess(response);

  return {
    ...result,
    launched: (result.launched as AndroidApp | undefined) ?? target,
    localizationNote:
      appName === undefined
        ? undefined
        : "Name launch matched package/activity-derived aliases from the Android device. If localization matters, call android_list_apps and launch by applicationId."
  };
}

function findAppByApplicationId(apps: AndroidApp[], applicationId: string): AndroidApp {
  const app = apps.find((candidate) => candidate.applicationId === applicationId);
  if (!app) {
    throw new ToolInputError(`No launcher app found for applicationId '${applicationId}'.`);
  }
  return app;
}

function findAppByName(apps: AndroidApp[], appName: string, allowSubstring: boolean, throwOnFailure: boolean): AndroidApp | undefined {
  const needle = normalizeAppName(appName);
  const exact = apps.filter((app) => searchableAppStrings(app).some((value) => normalizeAppName(value) === needle));
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw ambiguousAppName(appName, exact);
  }

  if (allowSubstring) {
    const partial = apps.filter((app) => searchableAppStrings(app).some((value) => normalizeAppName(value).includes(needle)));
    if (partial.length === 1) {
      return partial[0];
    }
    if (partial.length > 1) {
      throw ambiguousAppName(appName, partial);
    }
  }

  const candidates = apps
    .filter((app) => fuzzyCandidate(app, needle))
    .slice(0, 10)
    .map(appSummary);
  if (!throwOnFailure) {
    return undefined;
  }
  throw new ToolInputError(
    `No launcher app matched appName '${appName}'. App-name matching uses package/activity-derived aliases from the Android device; call android_list_apps and launch by applicationId. Candidates: ${JSON.stringify(candidates)}`
  );
}

function ambiguousAppName(appName: string, apps: AndroidApp[]): ToolInputError {
  return new ToolInputError(
    `appName '${appName}' matched multiple launcher apps; use applicationId. Matches: ${JSON.stringify(apps.slice(0, 20).map(appSummary))}`
  );
}

function appSummary(app: AndroidApp): Record<string, string> {
  return {
    applicationId: app.applicationId,
    name: app.name,
    activityName: app.activityName,
    labelSource: app.labelSource
  };
}

function fuzzyCandidate(app: AndroidApp, needle: string): boolean {
  const tokens = needle.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  const haystack = normalizeAppName(searchableAppStrings(app).join(" "));
  return tokens.every((token) => haystack.includes(token));
}

function searchableAppStrings(app: AndroidApp): string[] {
  return [app.name, app.applicationId, app.activityName, ...app.aliases];
}

function normalizeAppName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyUserApp(applicationId: string): boolean {
  return !(
    applicationId.startsWith("android.") ||
    applicationId.startsWith("com.android.") ||
    applicationId.startsWith("com.google.android.") ||
    applicationId.startsWith("com.samsung.")
  );
}

async function getLauncherApps(): Promise<AndroidApp[]> {
  const response = await androidBridgeRpc("listApps");
  const apps = response.apps;
  if (!Array.isArray(apps)) {
    throw new AndroidBridgeError("Android bridge listApps response did not include apps.", { response });
  }
  return apps.map(normalizeAndroidApp).sort((a, b) => a.name.localeCompare(b.name) || a.applicationId.localeCompare(b.applicationId));
}

function normalizeAndroidApp(value: unknown): AndroidApp {
  const app = expectObject(value);
  const aliases = app.aliases;
  return {
    applicationId: stringParam(app, "applicationId"),
    activityName: stringParam(app, "activityName"),
    componentName: stringParam(app, "componentName"),
    name: stringParam(app, "name"),
    labelSource: stringParam(app, "labelSource") as AndroidApp["labelSource"],
    aliases: Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === "string") : []
  };
}

const integerSchema = { type: "integer", minimum: 0 };
const positiveIntegerSchema = { type: "integer", minimum: 1 };
const roiSchema = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: integerSchema,
  description: "Optional OCR region as [x1, y1, x2, y2] in screenshot coordinates."
};
const ocrCommonProperties = {
  roi: roiSchema,
  langs: { type: "string", minLength: 1, default: "chi_sim+eng" },
  ocrEngine: { type: "string", enum: ["tesseract", "apple-vision"], default: "apple-vision" },
  maxNodes: { type: "integer", minimum: 1, default: 80 },
  minConfidence: { type: "integer", minimum: 0, maximum: 100, default: 45 },
  retain: { type: "boolean", default: false },
  includeRawOcr: { type: "boolean", default: false }
};
const selectorSchema = {
  type: "object",
  properties: {
    text: { type: "string", minLength: 1 },
    contentDesc: { type: "string", minLength: 1 },
    resourceId: { type: "string", minLength: 1 },
    className: { type: "string", minLength: 1 },
    bounds: { type: "string", minLength: 1 },
    occurrence: { type: "integer", minimum: 1, default: 1 }
  },
  additionalProperties: false
};

const tools: ToolDefinition[] = [
  {
    name: "android_bridge_ping",
    description: "Check that the persistent on-device UIAutomator bridge is reachable through adb forward.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidBridgePing
  },
  {
    name: "android_bridge_exit",
    description: "Ask the persistent on-device UIAutomator bridge to stop serving requests.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidBridgeExit
  },
  {
    name: "android_screenshot",
    description: "Capture the current Android screen with adb exec-out screencap -p and return a local PNG path plus dimensions.",
    inputSchema: {
      type: "object",
      properties: {
        retain: {
          type: "boolean",
          default: false,
          description: "When false, overwrite one stable temp screenshot. When true, keep this screenshot in a unique temp directory."
        }
      },
      additionalProperties: false
    },
    handler: androidScreenshot
  },
  {
    name: "android_ocr_screen",
    description: "Run local OCR on the current Android screenshot and return compact text nodes with bounds and centers.",
    inputSchema: {
      type: "object",
      properties: ocrCommonProperties,
      additionalProperties: false
    },
    handler: androidOcrScreen
  },
  {
    name: "android_get_semantic_screen",
    description: "Return a unified compact screen model from accessibility nodes, with optional or automatic OCR fallback for sparse trees.",
    inputSchema: {
      type: "object",
      properties: {
        ocrMode: { type: "string", enum: ["auto", "force", "off"], default: "auto" },
        includeScreenshot: { type: "boolean", default: true },
        includeRawTree: { type: "boolean", default: false },
        ...ocrCommonProperties
      },
      additionalProperties: false
    },
    handler: androidGetSemanticScreen
  },
  {
    name: "android_dump_tree",
    description: "Dump the current Android accessibility tree as XML through the persistent on-device UIAutomator bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (input) => {
      optionalObject(input);
      return androidDumpTree();
    }
  },
  {
    name: "android_dump_compact",
    description: "Return a compact accessibility-node list from the persistent on-device UIAutomator bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (input) => {
      optionalObject(input);
      return androidDumpCompact();
    }
  },
  {
    name: "android_tap",
    description: "Tap a screen coordinate through the persistent on-device UIAutomator bridge.",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: { x: integerSchema, y: integerSchema },
      additionalProperties: false
    },
    handler: androidTap
  },
  {
    name: "android_tap_ref",
    description: "Tap an accessibility node by snapshot-local ref, with stale-screen detection and conservative relocation. OCR refs are observation-only and rejected.",
    inputSchema: {
      type: "object",
      required: ["snapshotId", "ref"],
      properties: {
        snapshotId: { type: "string", minLength: 1 },
        ref: { type: "string", minLength: 1 },
        returnSnapshot: { type: "boolean", default: true }
      },
      additionalProperties: false
    },
    handler: androidTapRef
  },
  {
    name: "android_swipe",
    description: "Swipe between two screen coordinates through the persistent on-device UIAutomator bridge.",
    inputSchema: {
      type: "object",
      required: ["x1", "y1", "x2", "y2"],
      properties: {
        x1: integerSchema,
        y1: integerSchema,
        x2: integerSchema,
        y2: integerSchema,
        durationMs: { ...integerSchema, default: 300 },
        steps: { ...positiveIntegerSchema, description: "Optional UIAutomator swipe steps. Defaults to durationMs / 5." }
      },
      additionalProperties: false
    },
    handler: androidSwipe
  },
  {
    name: "android_input_text",
    description: "Set text into the focused field, or edit a matching node by selector, through accessibility set_text.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1 },
        selector: selectorSchema,
        pressEnter: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    handler: androidInputText
  },
  {
    name: "android_perform_action",
    description: "Execute an accessibility action on a matching node selected by text, content description, resource ID, class name, or bounds.",
    inputSchema: {
      type: "object",
      required: ["action", "selector"],
      properties: {
        action: {
          type: "string",
          enum: ["click", "long_click", "scroll_forward", "scroll_backward", "expand", "collapse", "dismiss", "set_selection", "set_text"]
        },
        selector: selectorSchema
      },
      additionalProperties: false
    },
    handler: androidPerformAction
  },
  {
    name: "android_long_press",
    description: "Long press a screen coordinate through the persistent on-device UIAutomator bridge.",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: {
        x: integerSchema,
        y: integerSchema,
        durationMs: { ...integerSchema, default: 650 }
      },
      additionalProperties: false
    },
    handler: androidLongPress
  },
  {
    name: "android_key",
    description: "Send one supported Android key event through the persistent on-device UIAutomator bridge.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: { key: { type: "string", enum: Object.keys(KEYCODES) } },
      additionalProperties: false
    },
    handler: androidKey
  },
  {
    name: "android_list_apps",
    description: "List launcher apps with application IDs, launch activities, and best-effort localized app labels.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        includeSystem: { type: "boolean", default: true },
        resolveLabels: { type: "boolean", default: false }
      },
      additionalProperties: false
    },
    handler: androidListApps
  },
  {
    name: "android_launch_app",
    description: "Launch a launcher app by exact applicationId or by a unique appName match.",
    inputSchema: {
      type: "object",
      properties: {
        applicationId: { type: "string", minLength: 1 },
        appName: { type: "string", minLength: 1 },
        allowSubstring: { type: "boolean", default: true },
        resolveLabels: { type: "boolean", default: true }
      },
      additionalProperties: false
    },
    handler: androidLaunchApp
  }
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

function sendResponse(id: JsonRpcId | undefined, result: unknown): void {
  if (id === undefined) {
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function sendError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): void {
  if (id === undefined) {
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`);
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const { id, method } = request;
  if (!method) {
    sendError(id, -32600, "Invalid request: missing method.");
    return;
  }

  if (method === "initialize") {
    sendResponse(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "android-ui-mcp", version: "0.1.0" }
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    sendResponse(id, {
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    });
    return;
  }

  if (method === "tools/call") {
    await handleToolCall(id, request.params);
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

async function handleToolCall(id: JsonRpcId | undefined, params: unknown): Promise<void> {
  const call = expectObject(params);
  const name = stringParam(call, "name");
  const tool = toolMap.get(name);
  if (!tool) {
    sendError(id, -32602, `Unknown tool: ${name}`);
    return;
  }

  try {
    const result = await tool.handler(call.arguments);
    sendResponse(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    });
  } catch (error) {
    const err = error as Error;
    const data = error instanceof AdbCommandError || error instanceof AndroidBridgeError ? error.details : undefined;
    sendResponse(id, {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: err.message, data }, null, 2) }]
    });
  }
}

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      void parseAndHandle(line);
    }
    newlineIndex = buffer.indexOf("\n");
  }
});

async function parseAndHandle(line: string): Promise<void> {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    await handleRequest(request);
  } catch (error) {
    const err = error as Error;
    sendError(null, -32700, err.message);
  }
}
