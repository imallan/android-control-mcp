import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type AndroidApp = {
  applicationId: string;
  activityName: string;
  componentName: string;
  name: string;
  labelSource: "aapt" | "derived";
  aliases: string[];
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<ToolResult>;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.ANDROID_MCP_ADB_TIMEOUT_MS ?? 15_000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.ANDROID_MCP_SCREENSHOT_TIMEOUT_MS ?? 20_000);
const APP_LIST_TIMEOUT_MS = Number(process.env.ANDROID_MCP_APP_LIST_TIMEOUT_MS ?? 60_000);

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

async function execText(command: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024
  });
  return stdout;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function encodeAndroidInputText(text: string): string {
  return text
    .replaceAll("%", "%25")
    .replaceAll(" ", "%s")
    .replaceAll("\n", "%n")
    .replaceAll("\t", "%t");
}

async function androidScreenshot(input: unknown): Promise<ToolResult> {
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

async function androidDumpTree(): Promise<ToolResult> {
  await adbText(["shell", "uiautomator", "dump", "/sdcard/window.xml"]);
  const xml = await adbText(["exec-out", "cat", "/sdcard/window.xml"]);
  if (!xml.includes("<hierarchy")) {
    throw new Error("uiautomator dump did not return a hierarchy XML document.");
  }
  return { xml };
}

async function androidTap(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const x = numberParam(params, "x");
  const y = numberParam(params, "y");
  await adbText(["shell", "input", "tap", String(x), String(y)]);
  return { success: true };
}

async function androidSwipe(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const x1 = numberParam(params, "x1");
  const y1 = numberParam(params, "y1");
  const x2 = numberParam(params, "x2");
  const y2 = numberParam(params, "y2");
  const durationMs = params.durationMs === undefined ? 300 : numberParam(params, "durationMs");
  await adbText(["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)]);
  return { success: true };
}

async function androidInputText(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const text = stringParam(params, "text");
  const encoded = encodeAndroidInputText(text);
  await adbText(["shell", `input text ${shellQuote(encoded)}`]);
  return { success: true };
}

async function androidKey(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const key = stringParam(params, "key").toUpperCase();
  const keycode = KEYCODES[key];
  if (!keycode) {
    throw new ToolInputError(`key must be one of: ${Object.keys(KEYCODES).join(", ")}.`);
  }
  await adbText(["shell", "input", "keyevent", keycode]);
  return { success: true, key, keycode };
}

async function androidListApps(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const query = optionalStringParam(params, "query");
  const includeSystem = optionalBooleanParam(params, "includeSystem", true);
  const resolveLabels = optionalBooleanParam(params, "resolveLabels", false);
  const apps = await getLauncherApps(resolveLabels);
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
      "Fast app names are derived from package/activity names. Set resolveLabels=true to parse APK labels with local aapt; labels may differ by device locale. Use applicationId for deterministic launching."
  };
}

async function androidLaunchApp(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const applicationId = optionalStringParam(params, "applicationId");
  const appName = optionalStringParam(params, "appName");
  const allowSubstring = optionalBooleanParam(params, "allowSubstring", true);
  const resolveLabels = optionalBooleanParam(params, "resolveLabels", true);

  if (!applicationId && !appName) {
    throw new ToolInputError("Provide applicationId or appName.");
  }
  if (applicationId && appName) {
    throw new ToolInputError("Provide only one of applicationId or appName.");
  }

  const apps = await getLauncherApps(false);
  let target = applicationId ? findAppByApplicationId(apps, applicationId) : findAppByName(apps, appName as string, allowSubstring, false);
  if (!applicationId && target === undefined && resolveLabels) {
    target = findAppByName(await getLauncherApps(true), appName as string, allowSubstring, true);
  }
  if (!target) {
    throw new ToolInputError(
      `No launcher app matched appName '${appName}'. App-name matching is localization-sensitive; call android_list_apps with resolveLabels=true, then launch by applicationId.`
    );
  }
  await adbText(["shell", "monkey", "-p", target.applicationId, "-c", "android.intent.category.LAUNCHER", "1"]);

  return {
    success: true,
    launched: target,
    localizationNote:
      appName === undefined
        ? undefined
        : target.labelSource === "aapt"
          ? "Name launch matched APK labels parsed on this machine. If localization causes a mismatch, call android_list_apps and launch by applicationId."
          : "Name launch matched fast package/activity-derived aliases, not a localized launcher label. If localization matters, call android_list_apps with resolveLabels=true, then launch by applicationId."
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
    `No launcher app matched appName '${appName}'. App-name matching depends on localized APK labels; call android_list_apps and launch by applicationId. Candidates: ${JSON.stringify(candidates)}`
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

async function getLauncherApps(resolveLabels: boolean): Promise<AndroidApp[]> {
  const output = await adbText(
    ["shell", "cmd", "package", "query-activities", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER"],
    APP_LIST_TIMEOUT_MS
  );
  const components = parseLauncherComponents(output);
  const apps = await Promise.all(components.map((component) => buildAndroidApp(component, resolveLabels)));
  return apps.sort((a, b) => a.name.localeCompare(b.name) || a.applicationId.localeCompare(b.applicationId));
}

function parseLauncherComponents(output: string): Array<{ applicationId: string; activityName: string; componentName: string }> {
  const components: Array<{ applicationId: string; activityName: string; componentName: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes("/") || trimmed.startsWith("Activity #")) {
      continue;
    }
    const [applicationId, rawActivityName] = trimmed.split("/", 2);
    if (!applicationId || !rawActivityName || applicationId.includes(" ") || rawActivityName.includes(" ")) {
      continue;
    }
    const activityName = rawActivityName.startsWith(".") ? `${applicationId}${rawActivityName}` : rawActivityName;
    components.push({
      applicationId,
      activityName,
      componentName: `${applicationId}/${rawActivityName}`
    });
  }
  return components;
}

async function buildAndroidApp(component: { applicationId: string; activityName: string; componentName: string }, resolveLabel: boolean): Promise<AndroidApp> {
  const label = resolveLabel ? await readApkLabel(component.applicationId) : undefined;
  const derivedName = deriveAppName(component.applicationId, component.activityName);
  const name = label ?? derivedName;
  return {
    ...component,
    name,
    labelSource: label ? "aapt" : "derived",
    aliases: Array.from(
      new Set([
        derivedName,
        lastPackageSegment(component.applicationId),
        lastClassSegment(component.activityName),
        camelToWords(lastClassSegment(component.activityName)),
        component.applicationId
      ])
    )
  };
}

async function readApkLabel(applicationId: string): Promise<string | undefined> {
  try {
    const aapt = await findAapt();
    if (!aapt) {
      return undefined;
    }
    const pathOutput = await adbText(["shell", "pm", "path", applicationId]);
    const apkPath = pathOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("package:") && line.endsWith(".apk"))
      ?.replace(/^package:/, "");
    if (!apkPath) {
      return undefined;
    }
    const apk = await adbBuffer(["exec-out", "cat", apkPath], APP_LIST_TIMEOUT_MS);
    const dir = await mkdtemp(join(tmpdir(), "android-ui-mcp-apk-"));
    const apkFile = join(dir, `${applicationId.replaceAll(".", "_")}.apk`);
    await writeFile(apkFile, apk);
    try {
      const badging = await execText(aapt, ["dump", "badging", apkFile], APP_LIST_TIMEOUT_MS);
      return parseAaptLabel(badging);
    } finally {
      await unlink(apkFile).catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

function parseAaptLabel(badging: string): string | undefined {
  const preferred = badging.match(/^application-label:'([^']+)'$/m)?.[1];
  if (preferred) {
    return preferred;
  }
  return badging.match(/^application-label-[^:]+:'([^']+)'$/m)?.[1];
}

let cachedAaptPath: string | undefined | null;

async function findAapt(): Promise<string | undefined> {
  if (cachedAaptPath !== undefined) {
    return cachedAaptPath ?? undefined;
  }

  const explicit = process.env.AAPT_PATH;
  if (explicit) {
    cachedAaptPath = explicit;
    return explicit;
  }

  for (const sdkRoot of sdkRootCandidates()) {
    try {
      const buildTools = join(sdkRoot, "build-tools");
      const versions = (await readdir(buildTools, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(compareVersionsDesc);
      if (versions.length > 0) {
        cachedAaptPath = join(buildTools, versions[0], "aapt");
        return cachedAaptPath;
      }
    } catch {
      // Try the next SDK root candidate.
    }
  }

  cachedAaptPath = null;
  return undefined;
}

function sdkRootCandidates(): string[] {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    "/Volumes/数据/Android/sdk",
    join(process.env.HOME ?? "", "Library", "Android", "sdk")
  ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function compareVersionsDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}

function deriveAppName(applicationId: string, activityName: string): string {
  const activityWords = camelToWords(lastClassSegment(activityName))
    .split(/\s+/)
    .filter((word) => !["Activity", "Launcher", "Main", "Home", "Shell", "List", "Conversation"].includes(word));
  if (activityWords.length > 0 && activityWords.length <= 3) {
    return activityWords.join(" ");
  }
  return titleCase(lastPackageSegment(applicationId).replace(/[_-]+/g, " "));
}

function lastPackageSegment(applicationId: string): string {
  return applicationId.split(".").filter(Boolean).at(-1) ?? applicationId;
}

function lastClassSegment(activityName: string): string {
  return activityName.split(".").filter(Boolean).at(-1)?.replace(/\$.*$/, "") ?? activityName;
}

function camelToWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

const integerSchema = { type: "integer", minimum: 0 };

const tools: ToolDefinition[] = [
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
    name: "android_dump_tree",
    description: "Dump the current Android accessibility tree with uiautomator and return XML.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (input) => {
      optionalObject(input);
      return androidDumpTree();
    }
  },
  {
    name: "android_tap",
    description: "Tap a screen coordinate using adb shell input tap.",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: { x: integerSchema, y: integerSchema },
      additionalProperties: false
    },
    handler: androidTap
  },
  {
    name: "android_swipe",
    description: "Swipe between two screen coordinates using adb shell input swipe.",
    inputSchema: {
      type: "object",
      required: ["x1", "y1", "x2", "y2"],
      properties: {
        x1: integerSchema,
        y1: integerSchema,
        x2: integerSchema,
        y2: integerSchema,
        durationMs: { ...integerSchema, default: 300 }
      },
      additionalProperties: false
    },
    handler: androidSwipe
  },
  {
    name: "android_input_text",
    description: "Input text using adb shell input text. Spaces are encoded as %s.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string", minLength: 1 } },
      additionalProperties: false
    },
    handler: androidInputText
  },
  {
    name: "android_key",
    description: "Send one supported Android key event.",
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
    const data = error instanceof AdbCommandError ? error.details : undefined;
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
