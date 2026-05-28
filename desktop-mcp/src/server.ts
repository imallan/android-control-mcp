import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
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
const BRIDGE_HOST = process.env.ANDROID_UI_MCP_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.ANDROID_UI_MCP_PORT ?? 27_183);
const BRIDGE_TIMEOUT_MS = Number(process.env.ANDROID_UI_MCP_TIMEOUT_MS ?? 15_000);

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
    description: "Input text into the focused field with adb shell input text, or edit a matching node by selector with accessibility set_text.",
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
