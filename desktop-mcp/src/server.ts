import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startViewerHttpServer } from "./viewer.ts";
import type { ViewerHttpServer } from "./viewer.ts";

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

type DisplayTarget = { sessionId?: string; displayId?: number };

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
  checkable?: boolean;
  checked?: boolean;
  focused?: boolean;
  selected?: boolean;
  enabled?: boolean;
  depth?: number;
  windowIndex?: number;
  collectionScope?: number;
  collection?: {
    rowCount: number;
    columnCount: number;
    hierarchical?: boolean;
  };
  collectionItem?: {
    rowIndex: number;
    rowSpan: number;
    columnIndex: number;
    columnSpan: number;
    heading?: boolean;
  };
  actions?: string[];
  source: "accessibility" | "ocr" | "vision";
  confidence?: number;
  score?: number;
};

type SemanticSnapshot = {
  deviceId: string;
  displayId: number;
  sessionId?: string;
  snapshotId: string;
  screenSignature: string;
  actionableSignature: string;
  packageName?: string;
  width?: number;
  height?: number;
  nodes: SemanticNode[];
  nodeCount: number;
};

type SemanticScreenBuild = {
  deviceId: string;
  compact: Record<string, unknown>;
  snapshot: SemanticSnapshot;
  screenshot?: ScreenshotResult;
  tree: { usable: boolean; reason: string };
  ocrMode: OcrMode;
  visionMode: OcrMode;
  shouldRunOcr: boolean;
  shouldRunVision: boolean;
  options: ReturnType<typeof ocrOptions>;
  accessibilityNodeCount: number;
  ocr?: Awaited<ReturnType<typeof runOcr>>;
  vision?: Awaited<ReturnType<typeof runVisionDetect>>;
};

type ViewerCompanion = {
  http?: ViewerHttpServer;
  deviceId: string;
  target: DisplayTarget;
  allowActions: boolean;
  ocrMode: OcrMode;
  visionMode: OcrMode;
  maxNodes: number;
  currentFrame?: { snapshotId: string; png: Buffer };
  refreshPromise?: Promise<Record<string, unknown>>;
  operationQueue: Promise<unknown>;
};

type SnapshotCacheEntry = SemanticSnapshot & {
  createdAtMs: number;
};

type ResolvedRef =
  | {
      ok: true;
      status: "fresh" | "relocated";
      cached: SnapshotCacheEntry;
      originalNode: SemanticNode;
      current: SemanticSnapshot;
      targetNode: SemanticNode;
    }
  | {
      ok: false;
      status: "expired_snapshot" | "ref_not_found" | "unsupported_ref_source" | "stale_ref_not_found" | "stale_ref_ambiguous";
      message: string;
      snapshotId: string;
      ref: string;
      cached?: SnapshotCacheEntry;
      originalNode?: SemanticNode;
      current?: SemanticSnapshot;
      candidates?: Record<string, unknown>[];
      source?: SemanticNode["source"];
    };

type ScreenshotResult = ToolResult & {
  deviceId: string;
  imagePath: string;
  width: number;
  height: number;
  retained: boolean;
  displayId?: number;
  sessionId?: string;
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

type NodeLocator = {
  resourceId?: string;
  text?: string;
  contentDesc?: string;
  role?: string;
  className?: string;
  fuzzy: boolean;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<ToolResult>;
};
type CapabilityGroup = "core" | "ocr" | "apps" | "debug" | "trace" | "vision";

type AdbDeviceState = "device" | "offline" | "unauthorized" | string;

type AndroidDevice = {
  deviceId: string;
  state: AdbDeviceState;
  bridgeState?: BridgeState;
  bridgePort?: number;
  lastError?: string;
};

type BridgeState = "stopped" | "starting" | "running" | "failed";

type BridgeContext = {
  deviceId: string;
  port: number;
  state: BridgeState;
  process?: ChildProcessWithoutNullStreams;
  startPromise?: Promise<void>;
  lastError?: string;
  stdoutTail?: string;
  stderrTail?: string;
  queue: Promise<unknown>;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.ANDROID_MCP_ADB_TIMEOUT_MS ?? 15_000);
const SCREENSHOT_TIMEOUT_MS = Number(process.env.ANDROID_MCP_SCREENSHOT_TIMEOUT_MS ?? 20_000);
const OCR_TIMEOUT_MS = Number(process.env.ANDROID_MCP_OCR_TIMEOUT_MS ?? 90_000);
const BRIDGE_HOST = process.env.ANDROID_UI_MCP_HOST ?? "127.0.0.1";
const LEGACY_BRIDGE_PORT = Number(process.env.ANDROID_UI_MCP_PORT ?? 27_183);
const BRIDGE_PORT_BASE = Number(process.env.ANDROID_UI_MCP_PORT_BASE ?? process.env.ANDROID_UI_MCP_PORT ?? 27_183);
const BRIDGE_TIMEOUT_MS = Number(process.env.ANDROID_UI_MCP_TIMEOUT_MS ?? 15_000);
const BRIDGE_STARTUP_TIMEOUT_MS = Number(process.env.ANDROID_UI_MCP_STARTUP_TIMEOUT_MS ?? Math.max(30_000, BRIDGE_TIMEOUT_MS));
const BRIDGE_STARTUP_PROBE_TIMEOUT_MS = Number(process.env.ANDROID_UI_MCP_STARTUP_PROBE_TIMEOUT_MS ?? Math.min(1_000, BRIDGE_TIMEOUT_MS));
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(MODULE_DIR, "..", "..");
const ANDROID_SERVER_JAR = process.env.ANDROID_UI_MCP_JAR ?? join(REPO_DIR, "android-server", "build", "android-ui-server.jar");
const APPLE_VISION_OCR_SOURCE = join(MODULE_DIR, "..", "apple-vision-ocr.swift");
const APPLE_VISION_OCR_BIN = process.env.ANDROID_MCP_APPLE_VISION_OCR_BIN ?? join(tmpdir(), "android-ui-mcp", "apple-vision-ocr");
const APPLE_VISION_DETECT_SOURCE = join(MODULE_DIR, "..", "apple-vision-detect.swift");
const APPLE_VISION_DETECT_BIN = process.env.ANDROID_MCP_APPLE_VISION_DETECT_BIN ?? join(tmpdir(), "android-ui-mcp", "apple-vision-detect");
const CLANG_MODULE_CACHE_DIR = join(tmpdir(), "android-ui-mcp", "clang-module-cache");
const VISION_DETECT_TIMEOUT_MS = Number(process.env.ANDROID_MCP_VISION_DETECT_TIMEOUT_MS ?? 30_000);
const SNAPSHOT_CACHE_LIMIT = 20;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 300;
const DEFAULT_STABLE_TIMEOUT_MS = 1_500;
const DEFAULT_STABLE_POLL_INTERVAL_MS = 150;
const DEFAULT_VIRTUAL_DISPLAY_WIDTH = 1280;
const DEFAULT_VIRTUAL_DISPLAY_HEIGHT = 960;
const DEFAULT_VIRTUAL_DISPLAY_DPI = 160;
const DEFAULT_VIRTUAL_FRAME_TIMEOUT_MS = 2_000;
const OCR_CACHE_LIMIT = 20;
const TRACE_ROOT = process.env.ANDROID_MCP_TRACE_DIR ?? join(tmpdir(), "android-ui-mcp", "traces");
const ALL_CAPABILITY_GROUPS: CapabilityGroup[] = ["core", "ocr", "apps", "debug", "trace", "vision"];
const enabledCapabilityGroups = new Set<CapabilityGroup>(
  (process.env.ANDROID_MCP_CAPABILITIES?.split(",").map((value) => value.trim()).filter((value): value is CapabilityGroup => ALL_CAPABILITY_GROUPS.includes(value as CapabilityGroup))
    ?? ALL_CAPABILITY_GROUPS)
);

const snapshotCache = new Map<string, SnapshotCacheEntry>();
const activeVirtualSessions = new Map<string, string>();
const staleVirtualSessions = new Map<string, "bridge_restarted" | "virtual_display_recreated" | "virtual_display_not_found">();
const ocrCache = new Map<string, { nodes: SemanticNode[]; rawOcr: string }>();

type TraceState = { traceId: string; directory: string; startedAt: string; step: number };
let activeTrace: TraceState | undefined;
let activeViewer: ViewerCompanion | undefined;

function invalidateSnapshots(deviceId: string, sessionId?: string): void {
  for (const [snapshotId, snapshot] of snapshotCache) {
    if (snapshot.deviceId === deviceId && (sessionId === undefined || snapshot.sessionId === sessionId)) {
      snapshotCache.delete(snapshotId);
    }
  }
}

function invalidateVirtualSessions(deviceId: string, reason: "bridge_restarted" | "virtual_display_recreated"): void {
  for (const [sessionId, ownerDeviceId] of activeVirtualSessions) {
    if (ownerDeviceId === deviceId) {
      activeVirtualSessions.delete(sessionId);
      staleVirtualSessions.set(sessionId, reason);
    }
  }
}

const KEYCODES: Record<string, string> = {
  BACK: "KEYCODE_BACK",
  HOME: "KEYCODE_HOME",
  ENTER: "KEYCODE_ENTER",
  APP_SWITCH: "KEYCODE_APP_SWITCH",
  ESCAPE: "KEYCODE_ESCAPE",
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

class AndroidDeviceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "AndroidDeviceError";
    this.details = details;
  }
}

class DeviceManager {
  private readonly bridges = new Map<string, BridgeContext>();
  private readonly allocatedPorts = new Map<string, number>();

  async listDevices(): Promise<AndroidDevice[]> {
    let stdout: string;
    try {
      const result = await execFileAsync("adb", ["devices"], {
        encoding: "utf8",
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      });
      stdout = result.stdout;
    } catch (error) {
      throw normalizeAdbError(["devices"], error);
    }
    return stdout
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [deviceId, state = "unknown"] = line.split(/\s+/);
        const bridge = this.bridges.get(deviceId);
        return {
          deviceId,
          state,
          ...(bridge
            ? {
                bridgeState: bridge.state,
                bridgePort: bridge.port,
                ...(bridge.lastError ? { lastError: bridge.lastError } : {})
              }
            : {})
        };
      });
  }

  async resolveDeviceId(input: Record<string, unknown> = {}): Promise<string> {
    const explicit = optionalStringParam(input, "deviceId");
    const envDefault = process.env.ANDROID_SERIAL || undefined;
    const requested = explicit ?? envDefault;
    const devices = await this.listDevices();
    const authorized = devices.filter((device) => device.state === "device");

    if (requested) {
      const found = devices.find((device) => device.deviceId === requested);
      if (!found) {
        throw new AndroidDeviceError(`Android device '${requested}' is not connected.`, {
          status: "device_not_found",
          deviceId: requested,
          devices
        });
      }
      if (found.state !== "device") {
        throw new AndroidDeviceError(`Android device '${requested}' is ${found.state}, not authorized for ADB use.`, {
          status: "device_unavailable",
          deviceId: requested,
          state: found.state,
          devices
        });
      }
      return requested;
    }

    if (authorized.length === 0) {
      throw new AndroidDeviceError("No authorized Android device is connected.", {
        status: "no_device",
        devices
      });
    }
    if (authorized.length > 1) {
      throw new AndroidDeviceError("Multiple Android devices are connected; pass deviceId.", {
        status: "ambiguous_device",
        devices: authorized
      });
    }
    return authorized[0].deviceId;
  }

  async ensureBridge(deviceId: string): Promise<BridgeContext> {
    const bridge = this.bridgeForDevice(deviceId);
    if (bridge.state === "running" && bridge.process && bridge.process.exitCode === null) {
      return bridge;
    }
    if (!bridge.startPromise) {
      bridge.startPromise = this.startBridgeWithRetry(bridge).finally(() => {
        bridge.startPromise = undefined;
      });
    }
    await bridge.startPromise;
    return bridge;
  }

  async runOnDevice<T>(deviceId: string, action: () => Promise<T>): Promise<T> {
    const bridge = this.bridgeForDevice(deviceId);
    const previous = bridge.queue.catch(() => undefined);
    const next = previous.then(action, action);
    bridge.queue = next.catch(() => undefined);
    return next;
  }

  bridgeStatus(deviceId: string): { bridgeState: BridgeState; bridgePort: number; lastError?: string } {
    const bridge = this.bridgeForDevice(deviceId);
    return {
      bridgeState: bridge.state,
      bridgePort: bridge.port,
      ...(bridge.lastError ? { lastError: bridge.lastError } : {})
    };
  }

  runningBridge(deviceId: string): BridgeContext | undefined {
    const bridge = this.bridges.get(deviceId);
    if (bridge?.state === "running" && bridge.process && bridge.process.exitCode === null) {
      return bridge;
    }
    return undefined;
  }

  stopBridge(deviceId: string): void {
    const bridge = this.bridges.get(deviceId);
    if (!bridge) {
      return;
    }
    bridge.process?.kill();
    bridge.process = undefined;
    bridge.state = "stopped";
    invalidateSnapshots(deviceId);
    invalidateVirtualSessions(deviceId, "bridge_restarted");
  }

  stopAll(): void {
    for (const bridge of this.bridges.values()) {
      bridge.process?.kill();
      bridge.process = undefined;
      if (bridge.state === "running" || bridge.state === "starting") {
        bridge.state = "stopped";
      }
    }
  }

  private bridgeForDevice(deviceId: string): BridgeContext {
    let bridge = this.bridges.get(deviceId);
    if (!bridge) {
      bridge = {
        deviceId,
        port: this.portForDevice(deviceId),
        state: "stopped",
        queue: Promise.resolve()
      };
      this.bridges.set(deviceId, bridge);
    }
    return bridge;
  }

  private portForDevice(deviceId: string): number {
    const existing = this.allocatedPorts.get(deviceId);
    if (existing !== undefined) {
      return existing;
    }
    const used = new Set(this.allocatedPorts.values());
    let port = this.allocatedPorts.size === 0 ? LEGACY_BRIDGE_PORT : BRIDGE_PORT_BASE;
    while (used.has(port)) {
      port += 1;
    }
    this.allocatedPorts.set(deviceId, port);
    return port;
  }

  private async startBridgeWithRetry(bridge: BridgeContext): Promise<void> {
    try {
      await this.startBridge(bridge);
    } catch (error) {
      const message = (error as Error).message;
      if (!message.includes("Error while registering UiTestAutomationService")) {
        throw error;
      }
      await sleep(1_000);
      await this.startBridge(bridge);
    }
  }

  private async startBridge(bridge: BridgeContext): Promise<void> {
    invalidateSnapshots(bridge.deviceId);
    invalidateVirtualSessions(bridge.deviceId, "bridge_restarted");
    bridge.state = "starting";
    bridge.lastError = undefined;
    try {
      try {
        await stat(ANDROID_SERVER_JAR);
      } catch {
        throw new AndroidBridgeError("Android bridge jar is missing. Build it before using bridge-backed tools.", {
          jarPath: ANDROID_SERVER_JAR,
          hint: "Run android-server/scripts/build-uiautomator-jar.sh."
        });
      }
      await adbTextForDevice(bridge.deviceId, ["push", ANDROID_SERVER_JAR, "/data/local/tmp/android-ui-server.jar"]);
      await adbTextForDevice(bridge.deviceId, ["forward", `tcp:${bridge.port}`, "localabstract:android-ui-mcp"]);
      bridge.process?.kill();
      bridge.stdoutTail = "";
      bridge.stderrTail = "";
      bridge.process = spawn("adb", [
        "-s",
        bridge.deviceId,
        "shell",
        "uiautomator",
        "runtest",
        "/data/local/tmp/android-ui-server.jar",
        "-c",
        "com.example.androiduiserver.BridgeTest#testServe"
      ]);
      bridge.process.stdout.setEncoding("utf8");
      bridge.process.stdout.on("data", (chunk) => {
        bridge.stdoutTail = appendOutputTail(bridge.stdoutTail, String(chunk));
      });
      bridge.process.stderr.setEncoding("utf8");
      bridge.process.stderr.on("data", (chunk) => {
        bridge.stderrTail = appendOutputTail(bridge.stderrTail, String(chunk));
        bridge.lastError = bridgeProcessMessage(bridge, "Bridge stderr.");
      });
      bridge.process.on("error", (error) => {
        bridge.state = "failed";
        bridge.lastError = error.message;
        invalidateSnapshots(bridge.deviceId);
        invalidateVirtualSessions(bridge.deviceId, "bridge_restarted");
      });
      bridge.process.on("exit", (code, signal) => {
        bridge.state = code === 0 ? "stopped" : "failed";
        invalidateSnapshots(bridge.deviceId);
        invalidateVirtualSessions(bridge.deviceId, "bridge_restarted");
        if (code !== 0 || signal) {
          bridge.lastError = bridgeProcessMessage(bridge, `Bridge process exited with code ${code ?? "null"} signal ${signal ?? "null"}.`);
        }
      });
      await Promise.race([waitForBridgeReady(bridge), waitForBridgeProcessExit(bridge)]);
      bridge.state = "running";
    } catch (error) {
      bridge.state = "failed";
      bridge.lastError = bridgeProcessMessageIfNeeded(bridge, (error as Error).message);
      bridge.process?.kill();
      bridge.process = undefined;
      throw error;
    }
  }
}

function appendOutputTail(previous: string | undefined, chunk: string, limit = 4_000): string {
  const next = `${previous ?? ""}${chunk}`;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function bridgeProcessMessage(bridge: BridgeContext, message: string): string {
  const parts = [message];
  if (bridge.stderrTail?.trim()) {
    parts.push(`stderr: ${truncate(bridge.stderrTail.trim())}`);
  }
  if (bridge.stdoutTail?.trim()) {
    parts.push(`stdout: ${truncate(bridge.stdoutTail.trim())}`);
  }
  return parts.join(" ");
}

function bridgeProcessMessageIfNeeded(bridge: BridgeContext, message: string): string {
  if (message.includes("stderr:") || message.includes("stdout:")) {
    return message;
  }
  return bridgeProcessMessage(bridge, message);
}

function waitForBridgeProcessExit(bridge: BridgeContext): Promise<never> {
  const process = bridge.process;
  if (!process) {
    return Promise.reject(new AndroidBridgeError("Android bridge process was not started.", { deviceId: bridge.deviceId, port: bridge.port }));
  }
  return new Promise((_, reject) => {
    process.once("exit", (code, signal) => {
      reject(
        new AndroidBridgeError(bridgeProcessMessage(bridge, `Android bridge process exited before becoming ready.`), {
          deviceId: bridge.deviceId,
          port: bridge.port,
          code,
          signal,
          stdout: truncate(bridge.stdoutTail ?? ""),
          stderr: truncate(bridge.stderrTail ?? "")
        })
      );
    });
    process.once("error", (error) => {
      reject(
        new AndroidBridgeError(`Android bridge process failed before becoming ready: ${error.message}`, {
          deviceId: bridge.deviceId,
          port: bridge.port,
          stdout: truncate(bridge.stdoutTail ?? ""),
          stderr: truncate(bridge.stderrTail ?? "")
        })
      );
    });
  });
}

const deviceManager = new DeviceManager();

process.on("exit", () => {
  activeViewer?.http?.server.close();
  deviceManager.stopAll();
});

function adbBaseArgs(deviceId?: string): string[] {
  return deviceId ? ["-s", deviceId] : [];
}

async function adbBuffer(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, deviceId?: string): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("adb", [...adbBaseArgs(deviceId), ...args], {
      encoding: "buffer",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    throw normalizeAdbError(args, error, deviceId);
  }
}

async function adbText(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS, deviceId?: string): Promise<string> {
  return adbTextForDevice(deviceId, args, timeoutMs);
}

async function adbTextForDevice(deviceId: string | undefined, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await execFileAsync("adb", [...adbBaseArgs(deviceId), ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    throw normalizeAdbError(args, error, deviceId);
  }
}

async function waitForBridgeReady(bridge: BridgeContext): Promise<void> {
  const deadline = performance.now() + BRIDGE_STARTUP_TIMEOUT_MS;
  let lastError: Error | undefined;
  while (performance.now() <= deadline) {
    try {
      await bridgeRpcOnPort(bridge.deviceId, bridge.port, "ping", {}, BRIDGE_STARTUP_PROBE_TIMEOUT_MS);
      return;
    } catch (error) {
      lastError = error as Error;
      await sleep(250);
    }
  }
  throw new AndroidBridgeError(bridgeProcessMessage(bridge, "Android bridge did not become ready before timeout."), {
    deviceId: bridge.deviceId,
    host: BRIDGE_HOST,
    port: bridge.port,
    timeoutMs: BRIDGE_STARTUP_TIMEOUT_MS,
    probeTimeoutMs: BRIDGE_STARTUP_PROBE_TIMEOUT_MS,
    lastError: lastError?.message,
    stdout: truncate(bridge.stdoutTail ?? ""),
    stderr: truncate(bridge.stderrTail ?? "")
  });
}

async function androidBridgeRpc(
  deviceId: string,
  method: string,
  params: Record<string, string | number | boolean> = {}
): Promise<Record<string, unknown>> {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  const staleReason = sessionId ? staleVirtualSessions.get(sessionId) : undefined;
  if (sessionId && staleReason) {
    throw new AndroidBridgeError(`${staleReason}: virtual display session '${sessionId}' is no longer valid.`, {
      status: staleReason,
      deviceId,
      sessionId,
      method
    });
  }
  const bridge = await deviceManager.ensureBridge(deviceId);
  const staleReasonAfterStart = sessionId ? staleVirtualSessions.get(sessionId) : undefined;
  if (sessionId && staleReasonAfterStart) {
    throw new AndroidBridgeError(`${staleReasonAfterStart}: virtual display session '${sessionId}' is no longer valid.`, {
      status: staleReasonAfterStart,
      deviceId,
      sessionId,
      method
    });
  }
  return deviceManager.runOnDevice(deviceId, () => bridgeRpcOnPort(deviceId, bridge.port, method, params));
}

async function bridgeRpcOnPort(
  deviceId: string,
  port: number,
  method: string,
  params: Record<string, string | number | boolean> = {},
  timeoutMs = BRIDGE_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  return bridgeRpcAtEndpoint(deviceId, { host: BRIDGE_HOST, port }, method, params, timeoutMs);
}

async function bridgeRpcOnSocket(
  deviceId: string,
  path: string,
  method: string,
  params: Record<string, string | number | boolean> = {},
  timeoutMs = BRIDGE_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  return bridgeRpcAtEndpoint(deviceId, { path }, method, params, timeoutMs);
}

async function bridgeRpcAtEndpoint(
  deviceId: string,
  endpoint: { host: string; port: number } | { path: string },
  method: string,
  params: Record<string, string | number | boolean>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const start = performance.now();
  const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
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
          deviceId,
          method,
          ...endpoint,
          timeoutMs,
          hint: "Confirm the device is connected and android-server/build/android-ui-server.jar exists; the MCP server starts the bridge automatically."
        })
      );
    }, timeoutMs);

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
          deviceId,
          method,
          ...endpoint,
          hint: "The MCP server starts the bridge automatically; check android_list_devices for bridge state and lastError."
        })
      );
    });
  });

  response.hostElapsedMs = Math.round(performance.now() - start);
  if (response.ok !== true) {
    throw new AndroidBridgeError(`Android bridge ${method} failed.`, { deviceId, method, response });
  }
  return response;
}

function normalizeAdbError(args: string[], error: unknown, deviceId?: string): AdbCommandError {
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
    command: ["adb", ...adbBaseArgs(deviceId), ...args].join(" "),
    deviceId,
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

async function deviceIdParam(input: Record<string, unknown>): Promise<string> {
  return deviceManager.resolveDeviceId(input);
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

function displayTargetParams(input: Record<string, unknown>): DisplayTarget {
  const sessionId = optionalStringParam(input, "sessionId");
  const displayIdValue = input.displayId;
  const displayId =
    displayIdValue === undefined || displayIdValue === null
      ? undefined
      : (() => {
          if (!Number.isInteger(displayIdValue) || (displayIdValue as number) < 0) {
            throw new ToolInputError("displayId must be a non-negative integer when provided.");
          }
          return displayIdValue as number;
        })();
  if (sessionId !== undefined && displayId !== undefined) {
    throw new ToolInputError("Provide only one of sessionId or displayId.");
  }
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(displayId !== undefined ? { displayId } : {})
  };
}

function hasDisplayTarget(target: { sessionId?: string; displayId?: number }): boolean {
  return target.sessionId !== undefined || target.displayId !== undefined;
}

function bridgeDisplayTarget(target: DisplayTarget): Record<string, string | number> {
  return {
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.displayId !== undefined ? { displayId: target.displayId } : {})
  };
}

async function androidScreenshot(input: unknown): Promise<ScreenshotResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const retain = optionalBooleanParam(params, "retain", false);
  const target = displayTargetParams(params);
  const timeoutMs = optionalIntegerParam(params, "timeoutMs", DEFAULT_VIRTUAL_FRAME_TIMEOUT_MS);
  let png: Buffer;
  let displayId: number | undefined;
  let sessionId: string | undefined;
  if (hasDisplayTarget(target)) {
    if (target.displayId === 0) {
      throw new ToolInputError("displayId 0 is the default display; omit displayId to use the default screenshot path.");
    }
    const response = await androidBridgeRpc(deviceId, "captureFrame", {
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      ...(target.displayId !== undefined ? { displayId: target.displayId } : {}),
      timeoutMs
    });
    const pngBase64 = response.pngBase64;
    if (typeof pngBase64 !== "string" || pngBase64.length === 0) {
      throw new AndroidBridgeError("Android bridge captureFrame response did not include pngBase64.", { response });
    }
    png = Buffer.from(pngBase64, "base64");
    displayId = typeof response.displayId === "number" ? response.displayId : target.displayId;
    sessionId = typeof response.sessionId === "string" ? response.sessionId : target.sessionId;
  } else {
    png = await adbBuffer(["exec-out", "screencap", "-p"], SCREENSHOT_TIMEOUT_MS, deviceId);
    displayId = 0;
  }
  const { width, height } = parsePngSize(png);
  const targetSuffix = sessionId ?? (displayId !== undefined ? `display-${displayId}` : "display-0");
  const dir = retain ? await mkdtemp(join(tmpdir(), "android-ui-mcp-")) : join(tmpdir(), "android-ui-mcp", safeFileName(deviceId), safeFileName(targetSuffix));
  if (!retain) {
    await mkdir(dir, { recursive: true });
  }
  const imagePath = join(dir, "current-screen.png");
  await writeFile(imagePath, png);
  return { deviceId, imagePath, width, height, retained: retain, ...(displayId !== undefined ? { displayId } : {}), ...(sessionId ? { sessionId } : {}) };
}

async function androidOcrScreen(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const options = ocrOptions(params);
  const target = displayTargetParams(params);
  const screenshot = await androidScreenshot({ retain: options.retain, deviceId, ...target });
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
    ocrCached: ocr.cached,
    ...(options.includeRawOcr ? { rawOcr: ocr.rawOcr } : {})
  };
}

async function androidGetSemanticScreen(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const includeScreenshot = optionalBooleanParam(params, "includeScreenshot", true);
  const includeRawTree = optionalBooleanParam(params, "includeRawTree", false);
  const includeRawVision = optionalBooleanParam(params, "includeRawVision", false);
  const built = await buildSemanticScreen(params, includeScreenshot);
  const { deviceId, compact, snapshot, screenshot, tree, ocrMode, visionMode, shouldRunOcr, shouldRunVision, options, ocr, vision } = built;

  return {
    ...(includeScreenshot && screenshot ? screenshot : {}),
    deviceId,
    displayId: snapshot.displayId,
    ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    snapshotId: snapshot.snapshotId,
    screenSignature: snapshot.screenSignature,
    actionableSignature: snapshot.actionableSignature,
    packageName: compact.packageName,
    width: includeScreenshot && screenshot ? screenshot.width : compact.width,
    height: includeScreenshot && screenshot ? screenshot.height : compact.height,
    ocrMode,
    ocrUsed: shouldRunOcr,
    ocrEngine: shouldRunOcr ? options.ocrEngine : undefined,
    ocrReason: shouldRunOcr ? (ocrMode === "force" ? "forced" : tree.reason) : "not_needed",
    visionMode,
    visionUsed: shouldRunVision,
    visionEngine: shouldRunVision ? "apple-vision-detect" : undefined,
    visionNodeCount: vision?.nodes.length ?? 0,
    treeUsable: tree.usable,
    accessibilityNodeCount: built.accessibilityNodeCount,
    ocrNodeCount: ocr?.nodes.length ?? 0,
    ocrCached: ocr?.cached ?? false,
    nodes: snapshot.nodes,
    nodeCount: snapshot.nodeCount,
    ...(includeRawTree ? { compactTree: compact } : {}),
    ...(options.includeRawOcr && ocr ? { rawOcr: ocr.rawOcr } : {}),
    ...(includeRawVision && vision ? { rawVision: vision.rawDetect } : {})
  };
}

async function buildSemanticScreen(params: Record<string, unknown>, includeScreenshot: boolean): Promise<SemanticScreenBuild> {
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const options = ocrOptions(params);
  const ocrMode = optionalEnumParam(params, "ocrMode", ["auto", "force", "off"] as const, "auto");
  const visionMode = optionalEnumParam(params, "visionMode", ["auto", "force", "off"] as const, "auto");

  const compact = await androidDumpCompact(deviceId, target);
  const accessibilityNodes = compactNodes(compact);
  const tree = assessTreeUsability(compact, accessibilityNodes);
  const shouldRunOcr = ocrMode === "force" || (ocrMode === "auto" && !tree.usable);
  const shouldRunVision = visionMode === "force" || (visionMode === "auto" && !tree.usable && shouldRunOcr);
  const screenshot = includeScreenshot || shouldRunOcr || shouldRunVision
    ? await androidScreenshot({ retain: options.retain, deviceId, ...target })
    : undefined;

  // Run OCR and vision detection in parallel when both are needed
  const [ocr, vision] = await Promise.all([
    shouldRunOcr && screenshot ? runOcr(screenshot, options) : Promise.resolve(undefined),
    shouldRunVision && screenshot ? runVisionDetect(screenshot.imagePath, { minSize: 28, maxSize: 320 }).catch((err: Error): undefined => {
      process.stderr.write(`[android-ui-mcp] Vision detect failed (non-fatal): ${err.message}\n`);
      return undefined;
    }) : Promise.resolve(undefined)
  ]);

  const nodes = mergeSemanticNodes(accessibilityNodes, ocr?.nodes ?? [], vision?.nodes ?? [], options.maxNodes);
  const snapshot = createSemanticSnapshot(deviceId, compact, nodes);
  rememberSnapshot(snapshot);

  return {
    deviceId,
    compact,
    snapshot,
    screenshot,
    tree,
    ocrMode,
    visionMode,
    shouldRunOcr,
    shouldRunVision,
    options,
    accessibilityNodeCount: accessibilityNodes.length,
    ocr,
    vision
  };
}

function renderUiOutline(snapshot: SemanticSnapshot, maxLines: number): { outline: string; entries: Record<string, unknown>[]; lineCount: number; truncated: boolean } {
  const height = snapshot.height ?? Math.max(1, ...snapshot.nodes.map((node) => node.bounds[3]));
  const candidates = snapshot.nodes.filter((node) => node.ref && (outlineLabel(node) || isActionableNode(node)));
  const selected = [...candidates]
    .sort((a, b) => Number(isActionableNode(b)) - Number(isActionableNode(a)) || (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxLines);
  const scopeCounts = new Map<number, number>();
  for (const node of selected) {
    if (node.collectionItem && node.collectionScope !== undefined) {
      scopeCounts.set(node.collectionScope, (scopeCounts.get(node.collectionScope) ?? 0) + 1);
    }
  }
  const rankedScopes = [...scopeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([scope]) => scope);
  const scopeRank = new Map(rankedScopes.map((scope, index) => [scope, index + 1]));
  const entries = selected.map((node) => outlineEntry(node, height, scopeRank));
  const sections = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries) {
    const region = entry.region as string;
    const values = sections.get(region) ?? [];
    values.push(entry);
    sections.set(region, values);
  }
  for (const values of sections.values()) {
    values.sort((a, b) => {
      const ab = a.bounds as Bounds;
      const bb = b.bounds as Bounds;
      return ab[1] - bb[1] || ab[0] - bb[0];
    });
  }
  const secondary = [...sections.keys()].filter((name) => name.startsWith("Window ")).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
  const order = [...secondary, "Top", "Content", "Bottom"];
  const lines: string[] = [];
  for (const region of order) {
    const values = sections.get(region);
    if (!values?.length) continue;
    lines.push(`[${region}]`);
    for (const entry of values) {
      const states = entry.states as string[];
      lines.push(`  ${entry.ref}${entry.alias ? ` ${entry.alias}` : ""} ${entry.role} \"${escapeOutlineLabel(entry.label as string)}\"${states.length ? ` [${states.join(",")}]` : ""}`);
    }
  }
  return { outline: lines.join("\n"), entries, lineCount: selected.length, truncated: candidates.length > selected.length };
}

function outlineEntry(node: SemanticNode, height: number, scopeRank: Map<number, number>): Record<string, unknown> {
  const windowIndex = node.windowIndex ?? 0;
  const region = windowIndex > 0 ? `Window ${windowIndex + 1}` : node.center[1] < height * 0.18 ? "Top" : node.center[1] > height * 0.82 ? "Bottom" : "Content";
  const scope = node.collectionScope === undefined ? undefined : scopeRank.get(node.collectionScope);
  const row = node.collectionItem ? node.collectionItem.rowIndex + 1 : undefined;
  const alias = row === undefined || scope === undefined ? undefined : scope === 1 ? `#${row}` : `#${row}@${scope}`;
  const states: string[] = [];
  if (node.editable) states.push("editable");
  if (node.checkable) states.push(node.checked ? "checked" : "unchecked");
  if (node.selected) states.push("selected");
  if (node.focused) states.push("focused");
  if (node.enabled === false) states.push("disabled");
  if (node.clickable && node.role !== "button") states.push("clickable");
  if (node.scrollable) states.push("scrollable");
  return {
    ref: node.ref,
    ...(alias ? { alias } : {}),
    role: node.role ?? "element",
    label: outlineLabel(node) || "unlabeled",
    states,
    region,
    bounds: node.bounds,
    source: node.source,
    windowIndex,
    actionable: isActionableNode(node)
  };
}

function outlineLabel(node: SemanticNode): string {
  const resourceLabel = node.resourceId?.split("/").at(-1)?.replaceAll("_", " ");
  return truncate((node.text ?? node.contentDesc ?? resourceLabel ?? node.role ?? "").replace(/\s+/g, " ").trim(), 80);
}

function escapeOutlineLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", " ");
}

function isActionableNode(node: SemanticNode): boolean {
  return node.clickable === true || node.scrollable === true || node.editable === true || (node.actions?.length ?? 0) > 0;
}

async function androidGetUiOutline(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const includeScreenshot = optionalBooleanParam(params, "includeScreenshot", false);
  const includeEntries = optionalBooleanParam(params, "includeEntries", false);
  const maxLines = Math.min(500, Math.max(1, optionalIntegerParam(params, "maxLines", 80)));
  const built = await buildSemanticScreen(params, includeScreenshot);
  const rendered = renderUiOutline(built.snapshot, maxLines);
  return {
    ...(includeScreenshot && built.screenshot ? built.screenshot : {}),
    success: true,
    deviceId: built.deviceId,
    displayId: built.snapshot.displayId,
    ...(built.snapshot.sessionId ? { sessionId: built.snapshot.sessionId } : {}),
    snapshotId: built.snapshot.snapshotId,
    screenSignature: built.snapshot.screenSignature,
    actionableSignature: built.snapshot.actionableSignature,
    packageName: built.snapshot.packageName,
    width: built.snapshot.width,
    height: built.snapshot.height,
    outline: rendered.outline,
    lineCount: rendered.lineCount,
    nodeCount: built.snapshot.nodeCount,
    truncated: rendered.truncated,
    treeUsable: built.tree.usable,
    ocrUsed: built.shouldRunOcr,
    visionUsed: built.shouldRunVision,
    ...(includeEntries ? { entries: rendered.entries } : {})
  };
}

async function androidViewerStart(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  if (activeViewer?.http) {
    return { success: false, status: "viewer_already_running", ...viewerStatus(activeViewer) };
  }
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const port = Math.min(65_535, Math.max(0, optionalIntegerParam(params, "port", 0)));
  const viewer: ViewerCompanion = {
    deviceId,
    target,
    allowActions: optionalBooleanParam(params, "allowActions", false),
    ocrMode: optionalEnumParam(params, "ocrMode", ["auto", "force", "off"] as const, "auto"),
    visionMode: optionalEnumParam(params, "visionMode", ["auto", "force", "off"] as const, "auto"),
    maxNodes: Math.min(500, Math.max(1, optionalIntegerParam(params, "maxNodes", 200))),
    operationQueue: Promise.resolve()
  };
  try {
    viewer.http = await startViewerHttpServer({
      port,
      callbacks: {
        status: () => viewerStatus(viewer),
        refresh: () => queueViewerRefresh(viewer),
        frame: async (snapshotId) => viewer.currentFrame?.snapshotId === snapshotId ? viewer.currentFrame.png : undefined,
        tap: (snapshotId, ref) => runViewerOperation(viewer, () => tapFromViewer(viewer, snapshotId, ref))
      }
    });
    activeViewer = viewer;
    return { success: true, status: "viewer_started", ...viewerStatus(viewer) };
  } catch (error) {
    await viewer.http?.close().catch(() => undefined);
    throw error;
  }
}

async function androidViewerStop(): Promise<ToolResult> {
  const viewer = activeViewer;
  if (!viewer?.http) return { success: true, status: "viewer_not_running" };
  activeViewer = undefined;
  await viewer.http.close();
  return { success: true, status: "viewer_stopped", deviceId: viewer.deviceId };
}

async function androidViewerStatus(): Promise<ToolResult> {
  return activeViewer?.http ? { success: true, status: "viewer_running", ...viewerStatus(activeViewer) } : { success: true, status: "viewer_not_running" };
}

function viewerStatus(viewer: ViewerCompanion): Record<string, unknown> {
  return {
    deviceId: viewer.deviceId,
    ...(viewer.target.sessionId ? { sessionId: viewer.target.sessionId } : {}),
    ...(viewer.target.displayId !== undefined ? { displayId: viewer.target.displayId } : {}),
    allowActions: viewer.allowActions,
    ocrMode: viewer.ocrMode,
    visionMode: viewer.visionMode,
    ...(viewer.http ? { host: "127.0.0.1", port: viewer.http.port, url: viewer.http.url } : {}),
    ...(viewer.currentFrame ? { snapshotId: viewer.currentFrame.snapshotId } : {})
  };
}

function runViewerOperation<T>(viewer: ViewerCompanion, operation: () => Promise<T>): Promise<T> {
  const next = viewer.operationQueue.then(operation, operation);
  viewer.operationQueue = next.catch(() => undefined);
  return next;
}

function queueViewerRefresh(viewer: ViewerCompanion): Promise<Record<string, unknown>> {
  if (viewer.refreshPromise) return viewer.refreshPromise;
  const refresh = runViewerOperation(viewer, () => captureViewerSnapshot(viewer));
  viewer.refreshPromise = refresh.finally(() => {
    viewer.refreshPromise = undefined;
  });
  return viewer.refreshPromise;
}

async function captureViewerSnapshot(viewer: ViewerCompanion): Promise<Record<string, unknown>> {
  const built = await buildSemanticScreen({
    deviceId: viewer.deviceId,
    ...viewer.target,
    ocrMode: viewer.ocrMode,
    visionMode: viewer.visionMode,
    maxNodes: viewer.maxNodes,
    retain: false
  }, true);
  if (!built.screenshot) throw new Error("Viewer refresh did not capture a screenshot.");
  const rendered = renderUiOutline(built.snapshot, viewer.maxNodes);
  viewer.currentFrame = { snapshotId: built.snapshot.snapshotId, png: await readFile(built.screenshot.imagePath) };
  return {
    success: true,
    deviceId: viewer.deviceId,
    displayId: built.snapshot.displayId,
    ...(built.snapshot.sessionId ? { sessionId: built.snapshot.sessionId } : {}),
    snapshotId: built.snapshot.snapshotId,
    screenSignature: built.snapshot.screenSignature,
    actionableSignature: built.snapshot.actionableSignature,
    packageName: built.snapshot.packageName,
    width: built.screenshot.width,
    height: built.screenshot.height,
    outline: rendered.outline,
    entries: rendered.entries,
    lineCount: rendered.lineCount,
    nodeCount: built.snapshot.nodeCount,
    truncated: rendered.truncated,
    allowActions: viewer.allowActions,
    treeUsable: built.tree.usable,
    ocrUsed: built.shouldRunOcr,
    visionUsed: built.shouldRunVision
  };
}

async function tapFromViewer(viewer: ViewerCompanion, snapshotId: string, ref: string): Promise<Record<string, unknown>> {
  if (!viewer.allowActions) {
    return { success: false, status: "actions_disabled", message: "Restart the Viewer with allowActions=true to enable ref actions." };
  }
  if (!/^a\d+$/.test(ref)) {
    return { success: false, status: "unsupported_ref_source", message: "Viewer actions only accept accessibility aN refs." };
  }
  const started = performance.now();
  try {
    const action = await androidTapRef({
      deviceId: viewer.deviceId,
      ...viewer.target,
      snapshotId,
      ref,
      returnSnapshot: true,
      waitForStable: true
    });
    const snapshot = await captureViewerSnapshot(viewer);
    const result = {
      success: action.success !== false,
      action: {
        success: action.success,
        status: action.status,
        actionStrategy: action.actionStrategy,
        message: action.message,
        from: action.from,
        target: action.target
      },
      snapshot
    };
    await recordTraceEvent("android_viewer_tap", { deviceId: viewer.deviceId, snapshotId, ref }, result, undefined, Math.round(performance.now() - started)).catch(() => undefined);
    return result;
  } catch (error) {
    await recordTraceEvent("android_viewer_tap", { deviceId: viewer.deviceId, snapshotId, ref }, undefined, error as Error, Math.round(performance.now() - started)).catch(() => undefined);
    throw error;
  }
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
): Promise<{ nodes: SemanticNode[]; rawOcr: string; elapsedMs: number; cached: boolean }> {
  const start = performance.now();
  const target = options.roi ? await cropImage(screenshot, options.roi) : { imagePath: screenshot.imagePath, offsetX: 0, offsetY: 0 };
  const image = await readFile(target.imagePath);
  const cacheKey = createHash("sha256")
    .update(image)
    .update(JSON.stringify({ engine: options.ocrEngine, langs: options.langs, minConfidence: options.minConfidence, offsetX: target.offsetX, offsetY: target.offsetY }))
    .digest("hex");
  const cached = ocrCache.get(cacheKey);
  if (cached) {
    ocrCache.delete(cacheKey);
    ocrCache.set(cacheKey, cached);
    return { ...cached, elapsedMs: Math.round(performance.now() - start), cached: true };
  }
  const result =
    options.ocrEngine === "apple-vision"
      ? await runAppleVisionOcr(target.imagePath, options.langs, options.minConfidence, target.offsetX, target.offsetY)
      : await runTesseractOcr(target.imagePath, options.langs, options.minConfidence, target.offsetX, target.offsetY);
  const entry = {
    nodes: result.nodes,
    rawOcr: result.rawOcr
  };
  ocrCache.set(cacheKey, entry);
  while (ocrCache.size > OCR_CACHE_LIMIT) {
    const oldest = ocrCache.keys().next().value as string | undefined;
    if (oldest) ocrCache.delete(oldest);
  }
  return { ...entry, elapsedMs: Math.round(performance.now() - start), cached: false };
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

// ---- Vision detection (icon / button regions) ----

async function runVisionDetect(
  imagePath: string,
  options: { minSize?: number; maxSize?: number; edgeThreshold?: number }
): Promise<{ nodes: SemanticNode[]; rawDetect: string; engine: string; elapsedMs: number }> {
  const start = performance.now();
  const bin = await ensureAppleVisionDetectBin();
  const args = [imagePath];
  if (options.minSize !== undefined) {
    args.push("--min-size", String(options.minSize));
  }
  if (options.maxSize !== undefined) {
    args.push("--max-size", String(options.maxSize));
  }
  if (options.edgeThreshold !== undefined) {
    args.push("--edge-threshold", String(options.edgeThreshold));
  }
  const rawDetect = await execText(bin, args, VISION_DETECT_TIMEOUT_MS);
  const nodes = parseAppleVisionDetect(rawDetect);
  return { nodes, rawDetect, engine: "apple-vision-detect", elapsedMs: performance.now() - start };
}

async function ensureAppleVisionDetectBin(): Promise<string> {
  try {
    await access(APPLE_VISION_DETECT_BIN);
    return APPLE_VISION_DETECT_BIN;
  } catch {
    await mkdir(dirname(APPLE_VISION_DETECT_BIN), { recursive: true });
    await mkdir(CLANG_MODULE_CACHE_DIR, { recursive: true });
    await execText("swiftc", [APPLE_VISION_DETECT_SOURCE, "-o", APPLE_VISION_DETECT_BIN], VISION_DETECT_TIMEOUT_MS);
    return APPLE_VISION_DETECT_BIN;
  }
}

function parseAppleVisionDetect(rawDetect: string): SemanticNode[] {
  const parsed = expectObject(JSON.parse(rawDetect));
  const rawNodes = parsed.nodes;
  if (!Array.isArray(rawNodes)) {
    throw new Error("Apple Vision detect output did not include nodes.");
  }

  const nodes: SemanticNode[] = [];
  for (const [index, rawNode] of rawNodes.entries()) {
    const node = expectObject(rawNode);
    const rawBounds = node.bounds;
    if (!Array.isArray(rawBounds) || rawBounds.length !== 4 || !rawBounds.every((value) => Number.isInteger(value) && value >= 0)) {
      continue;
    }
    const bounds: Bounds = [
      rawBounds[0] as number,
      rawBounds[1] as number,
      rawBounds[2] as number,
      rawBounds[3] as number
    ];
    const width = bounds[2] - bounds[0];
    const height = bounds[3] - bounds[1];
    // Skip degenerate regions
    if (width < 10 || height < 10) {
      continue;
    }
    const confidence = typeof node.confidence === "number" ? node.confidence : 50;
    nodes.push({
      id: `vision:${index + 1}`,
      bounds,
      center: boundsCenter(bounds),
      clickable: true,
      source: "vision",
      confidence,
      role: "icon"
    });
  }

  return nodes;
}

/// Remove vision detections that significantly overlap with existing accessibility or OCR text.
function filterVisionVsExisting(visionNodes: SemanticNode[], existingNodes: SemanticNode[]): SemanticNode[] {
  return visionNodes.filter((vn) => {
    const vText = (vn.text ?? "").trim();
    for (const en of existingNodes) {
      const eText = (en.text ?? en.contentDesc ?? "").trim();
      // If the vision region contains readable text that is already covered, skip it.
      if (eText.length > 0 && boundsOverlapRatio(vn.bounds, en.bounds) > 0.6) {
        return false;
      }
      // If the vision region is mostly covered by an accessibility node, skip it.
      if (en.source === "accessibility" && boundsOverlapRatio(vn.bounds, en.bounds) > 0.7) {
        return false;
      }
    }
    return true;
  });
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

  const dir = screenshot.retained ? await mkdtemp(join(tmpdir(), "android-ui-mcp-ocr-")) : dirname(screenshot.imagePath);
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
    const collection = optionalCompactCollection(node.collection);
    const collectionItem = optionalCompactCollectionItem(node.collectionItem);
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
      ...(node.checkable === true ? { checkable: true } : {}),
      ...(typeof node.checked === "boolean" ? { checked: node.checked } : {}),
      ...(node.focused === true ? { focused: true } : {}),
      ...(node.selected === true ? { selected: true } : {}),
      ...(typeof node.enabled === "boolean" ? { enabled: node.enabled } : {}),
      ...(typeof node.depth === "number" ? { depth: node.depth } : {}),
      ...(typeof node.windowIndex === "number" ? { windowIndex: node.windowIndex } : {}),
      ...(typeof node.collectionScope === "number" ? { collectionScope: node.collectionScope } : {}),
      ...(collection ? { collection } : {}),
      ...(collectionItem ? { collectionItem } : {}),
      ...(actions && actions.length > 0 ? { actions } : {}),
      source: "accessibility"
    });
  }
  return nodes;
}

function optionalCompactCollection(value: unknown): SemanticNode["collection"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.rowCount !== "number" || typeof raw.columnCount !== "number") return undefined;
  return {
    rowCount: raw.rowCount,
    columnCount: raw.columnCount,
    ...(typeof raw.hierarchical === "boolean" ? { hierarchical: raw.hierarchical } : {})
  };
}

function optionalCompactCollectionItem(value: unknown): SemanticNode["collectionItem"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (![raw.rowIndex, raw.rowSpan, raw.columnIndex, raw.columnSpan].every((part) => typeof part === "number")) return undefined;
  return {
    rowIndex: raw.rowIndex as number,
    rowSpan: raw.rowSpan as number,
    columnIndex: raw.columnIndex as number,
    columnSpan: raw.columnSpan as number,
    ...(typeof raw.heading === "boolean" ? { heading: raw.heading } : {})
  };
}

function assessTreeUsability(compact: Record<string, unknown>, nodes: SemanticNode[]): { usable: boolean; reason: string } {
  const packageName = typeof compact.packageName === "string" ? compact.packageName : "";
  if (["com.tencent.mm", "com.android.camera2"].includes(packageName)) {
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

function mergeSemanticNodes(accessibilityNodes: SemanticNode[], ocrNodes: SemanticNode[], visionNodes: SemanticNode[], maxNodes: number): SemanticNode[] {
  // Filter vision detections against accessibility + OCR nodes to avoid duplicates
  const filteredVision = filterVisionVsExisting(visionNodes, [...accessibilityNodes, ...ocrNodes]);
  const merged = dedupeSemanticNodes([...accessibilityNodes, ...ocrNodes, ...filteredVision]);
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
  let visionIndex = 0;
  return nodes.map((node) => {
    let ref: string;
    if (node.source === "accessibility") {
      ref = `a${++accessibilityIndex}`;
    } else if (node.source === "vision") {
      ref = `v${++visionIndex}`;
    } else {
      ref = `o${++ocrIndex}`;
    }
    return { ...node, ref };
  });
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
  let score = node.source === "accessibility" ? 0.4 : node.source === "vision" ? 0.25 : 0.2;
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
  return source === "accessibility" ? 0 : source === "vision" ? 1 : 2;
}

function createSemanticSnapshot(deviceId: string, compact: Record<string, unknown>, nodes: SemanticNode[]): SemanticSnapshot {
  // Signatures must not depend on the caller's maxNodes/OCR/vision options.
  const signatureNodes = rankSemanticNodes(compactNodes(compact));
  const screenSignature = createScreenSignature(compact, signatureNodes);
  const actionableSignature = createActionableSignature(compact, signatureNodes);
  return {
    deviceId,
    displayId: typeof compact.displayId === "number" ? compact.displayId : 0,
    ...(typeof compact.sessionId === "string" ? { sessionId: compact.sessionId } : {}),
    snapshotId: createSnapshotId(deviceId, typeof compact.sessionId === "string" ? compact.sessionId : `display-${typeof compact.displayId === "number" ? compact.displayId : 0}`, screenSignature),
    screenSignature,
    actionableSignature,
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

function currentAccessibilitySnapshot(deviceId: string, target: DisplayTarget = {}): Promise<SemanticSnapshot> {
  return androidDumpCompact(deviceId, target).then((compact) => {
    const nodes = mergeSemanticNodes(compactNodes(compact), [], [], 80);
    const snapshot = createSemanticSnapshot(deviceId, compact, nodes);
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

function createActionableSignature(compact: Record<string, unknown>, nodes: SemanticNode[]): string {
  const packageName = typeof compact.packageName === "string" ? compact.packageName : "";
  const width = typeof compact.width === "number" ? compact.width : "";
  const height = typeof compact.height === "number" ? compact.height : "";
  const signature = JSON.stringify({
    packageName,
    width,
    height,
    nodes: nodes
      .filter(isActionableForStability)
      .map((node) => ({
        role: node.role,
        text: node.text,
        contentDesc: node.contentDesc,
        resourceId: node.resourceId,
        className: node.className,
        bounds: coarseBounds(node.bounds),
        clickable: node.clickable === true,
        scrollable: node.scrollable === true,
        editable: node.editable === true
      }))
  });
  return createHash("sha256").update(signature).digest("hex").slice(0, 16);
}

function isActionableForStability(node: SemanticNode): boolean {
  return (
    node.source === "accessibility" &&
    (node.clickable === true ||
      node.scrollable === true ||
      node.editable === true ||
      node.role === "button" ||
      node.role === "textbox" ||
      node.role === "switch" ||
      node.role === "checkbox")
  );
}

function coarseBounds(bounds: Bounds, grid = 32): Bounds {
  return bounds.map((value) => Math.round(value / grid) * grid) as Bounds;
}

function createSnapshotId(deviceId: string, displayIdentity: string, screenSignature: string): string {
  const deviceHash = createHash("sha256").update(deviceId).digest("hex").slice(0, 8);
  const displayHash = createHash("sha256").update(displayIdentity).digest("hex").slice(0, 8);
  return `screen:${deviceHash}:${displayHash}:${Date.now()}:${screenSignature.slice(0, 10)}`;
}

function relocateAccessibilityNode(
  original: SemanticNode,
  currentNodes: SemanticNode[]
): { node?: SemanticNode; status: "stale_ref_not_found" | "stale_ref_ambiguous"; message: string; candidates?: Record<string, unknown>[] } {
  const candidates = currentNodes.filter((node) => node.source === "accessibility");
  const strategies: Array<{ name: string; matches: SemanticNode[] }> = [
    {
      name: "resourceId_class",
      matches:
        original.resourceId && original.className
          ? candidates.filter((node) => node.resourceId === original.resourceId && node.className === original.className)
          : []
    },
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

async function resolveAccessibilityRef(snapshotId: string, ref: string, requestedDeviceId?: string, requestedTarget: DisplayTarget = {}): Promise<ResolvedRef> {
  const cached = snapshotCache.get(snapshotId);
  if (!cached) {
    return {
      ok: false,
      status: "expired_snapshot",
      message: "The requested snapshotId is no longer cached. Call android_get_semantic_screen again.",
      snapshotId,
      ref
    };
  }
  if (requestedDeviceId && requestedDeviceId !== cached.deviceId) {
    return {
      ok: false,
      status: "ref_not_found",
      message: `The requested snapshot belongs to device '${cached.deviceId}', not '${requestedDeviceId}'.`,
      snapshotId,
      ref,
      cached
    };
  }
  if (hasDisplayTarget(requestedTarget)) {
    const requestedIdentity = requestedTarget.sessionId ?? `display-${requestedTarget.displayId ?? 0}`;
    const cachedIdentity = cached.sessionId ?? `display-${cached.displayId}`;
    if (requestedIdentity !== cachedIdentity) {
      return { ok: false, status: "ref_not_found", message: `The requested snapshot belongs to '${cachedIdentity}', not '${requestedIdentity}'.`, snapshotId, ref, cached };
    }
  }

  const originalNode = cached.nodes.find((node) => node.ref === ref);
  if (!originalNode) {
    return {
      ok: false,
      status: "ref_not_found",
      message: "The requested ref was not found in the cached snapshot.",
      snapshotId,
      ref,
      cached
    };
  }
  if (originalNode.source !== "accessibility") {
    return {
      ok: false,
      status: "unsupported_ref_source",
      message: `${originalNode.source === "vision" ? "Vision" : "OCR"} refs are observation-only and cannot be used as ref action targets. Only accessibility (a*) refs are action-capable.`,
      snapshotId,
      ref,
      cached,
      originalNode,
      source: originalNode.source
    };
  }

  const current = await currentAccessibilitySnapshot(cached.deviceId, cached.sessionId ? { sessionId: cached.sessionId } : { displayId: cached.displayId });
  if (current.screenSignature === cached.screenSignature) {
    return { ok: true, status: "fresh", cached, originalNode, current, targetNode: originalNode };
  }

  const relocated = relocateAccessibilityNode(originalNode, current.nodes);
  if (!relocated.node) {
    return {
      ok: false,
      status: relocated.status,
      message: relocated.message,
      snapshotId,
      ref,
      cached,
      originalNode,
      current,
      candidates: relocated.candidates
    };
  }
  return { ok: true, status: "relocated", cached, originalNode, current, targetNode: relocated.node };
}

function refFailureResult(result: Extract<ResolvedRef, { ok: false }>, returnSnapshot: boolean): ToolResult {
  return {
    success: false,
    status: result.status,
    message: result.message,
    snapshotId: result.snapshotId,
    ref: result.ref,
    ...(result.source ? { source: result.source } : {}),
    ...(result.originalNode && result.cached ? { from: nodeRefSummary(result.cached.snapshotId, result.originalNode) } : {}),
    ...(result.candidates ? { candidates: result.candidates } : {}),
    ...(returnSnapshot && result.current ? { currentSnapshot: result.current } : {})
  };
}

function selectorForNode(node: SemanticNode): NodeSelector {
  if (node.resourceId) {
    return { resourceId: node.resourceId };
  }
  if (node.text) {
    return { text: node.text };
  }
  if (node.contentDesc) {
    return { contentDesc: node.contentDesc };
  }
  return { className: node.className, bounds: boundsToSelector(node.bounds) };
}

function boundsToSelector(bounds: Bounds): string {
  return `[${bounds[0]},${bounds[1]}][${bounds[2]},${bounds[3]}]`;
}

async function inputTextIntoNode(deviceId: string, node: SemanticNode, text: string, pressEnter: boolean, target: DisplayTarget = {}): Promise<ToolResult> {
  const response = await androidBridgeRpc(deviceId, "inputText", {
    text,
    ...bridgeDisplayTarget(target),
    ...flattenSelector(selectorForNode(node))
  });
  const result = normalizeBridgeSuccess(response);
  if (pressEnter) {
    await androidBridgeRpc(deviceId, "key", { key: "ENTER", ...bridgeDisplayTarget(target) });
  }
  return result;
}

async function performActionOnNode(deviceId: string, node: SemanticNode, action: string, text: string | undefined, target: DisplayTarget = {}): Promise<ToolResult> {
  const response = await androidBridgeRpc(deviceId, "performAction", {
    action,
    ...(text !== undefined ? { text } : {}),
    ...bridgeDisplayTarget(target),
    ...flattenSelector(selectorForNode(node))
  });
  return normalizeBridgeSuccess(response);
}

function locatorFromParams(params: Record<string, unknown>): NodeLocator {
  const locator = {
    resourceId: optionalStringParam(params, "resourceId"),
    text: optionalStringParam(params, "text"),
    contentDesc: optionalStringParam(params, "contentDesc"),
    role: optionalStringParam(params, "role"),
    className: optionalStringParam(params, "className"),
    fuzzy: optionalBooleanParam(params, "fuzzy", false)
  };
  if (!locator.resourceId && !locator.text && !locator.contentDesc && !locator.role && !locator.className) {
    throw new ToolInputError("Provide at least one locator field: resourceId, text, contentDesc, role, or className.");
  }
  return locator;
}

function findNodesByLocator(nodes: SemanticNode[], locator: NodeLocator): SemanticNode[] {
  return nodes.filter((node) => {
    if (node.source !== "accessibility") {
      return false;
    }
    if (locator.resourceId && !matchesLocatorValue(node.resourceId, locator.resourceId, locator.fuzzy)) {
      return false;
    }
    if (locator.text && !matchesLocatorValue(node.text, locator.text, locator.fuzzy)) {
      return false;
    }
    if (locator.contentDesc && !matchesLocatorValue(node.contentDesc, locator.contentDesc, locator.fuzzy)) {
      return false;
    }
    if (locator.role && node.role !== locator.role) {
      return false;
    }
    if (locator.className && node.className !== locator.className) {
      return false;
    }
    return true;
  });
}

function findLabelNodes(nodes: SemanticNode[], label: string, fuzzy: boolean): SemanticNode[] {
  return nodes.filter(
    (node) =>
      node.source === "accessibility" &&
      (matchesLocatorValue(node.text, label, fuzzy) || matchesLocatorValue(node.contentDesc, label, fuzzy))
  );
}

function matchesLocatorValue(actual: string | undefined, expected: string, fuzzy: boolean): boolean {
  if (!actual) {
    return false;
  }
  if (!fuzzy) {
    return actual === expected;
  }
  return normalizeLocatorText(actual).includes(normalizeLocatorText(expected));
}

function normalizeLocatorText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

async function tapUniqueNode(
  deviceId: string,
  matches: SemanticNode[],
  snapshot: SemanticSnapshot,
  returnSnapshot: boolean,
  stableOptions: { waitForStable: boolean; stableTimeoutMs: number; stablePollIntervalMs: number },
  matchKind: string
): Promise<ToolResult> {
  if (matches.length === 0) {
    return noLocatorMatch(`${matchKind}_not_found`, "No accessibility node matched.", snapshot, returnSnapshot);
  }
  if (matches.length > 1) {
    return ambiguousLocatorMatch(`${matchKind}_ambiguous`, "Multiple accessibility nodes matched.", matches, snapshot, returnSnapshot);
  }
  const node = matches[0];
  const [x, y] = node.center;
  const target = snapshot.sessionId ? { sessionId: snapshot.sessionId } : { displayId: snapshot.displayId };
  const tapResult = normalizeBridgeSuccess(await androidBridgeRpc(deviceId, "tap", { x, y, ...bridgeDisplayTarget(target) }));
  const snapshotContext = await postActionSnapshot({ deviceId, target, returnSnapshot, ...stableOptions });
  return {
    ...tapResult,
    status: "matched",
    actionStrategy: "coordinate_tap",
    target: nodeRefSummary(snapshot.snapshotId, node),
    ...snapshotContext
  };
}

function noLocatorMatch(status: string, message: string, snapshot: SemanticSnapshot, returnSnapshot: boolean): ToolResult {
  return {
    success: false,
    status,
    message,
    ...(returnSnapshot ? { currentSnapshot: snapshot } : {})
  };
}

function ambiguousLocatorMatch(
  status: string,
  message: string,
  matches: SemanticNode[],
  snapshot: SemanticSnapshot,
  returnSnapshot: boolean
): ToolResult {
  return {
    success: false,
    status,
    message,
    candidates: matches.slice(0, 10).map((node) => nodeRefSummary(snapshot.snapshotId, node)),
    ...(returnSnapshot ? { currentSnapshot: snapshot } : {})
  };
}

function labelFieldDistance(label: SemanticNode, field: SemanticNode): number {
  const labelCenter = boundsCenter(label.bounds);
  const fieldCenter = boundsCenter(field.bounds);
  const verticalOverlap = Math.min(label.bounds[3], field.bounds[3]) - Math.max(label.bounds[1], field.bounds[1]);
  const sameRow = verticalOverlap > 0;
  const toRight = field.bounds[0] >= label.bounds[2] - 8;
  const below = field.bounds[1] >= label.bounds[3] - 8;
  if (!sameRow && !below) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = Math.max(0, field.bounds[0] - label.bounds[2]);
  const dy = Math.max(0, field.bounds[1] - label.bounds[3]);
  const centerDistance = Math.hypot(fieldCenter[0] - labelCenter[0], fieldCenter[1] - labelCenter[1]);
  if (sameRow && toRight) {
    return dx + centerDistance * 0.05;
  }
  if (below) {
    return dy + centerDistance * 0.1 + 80;
  }
  return Number.POSITIVE_INFINITY;
}

function waitOptions(input: Record<string, unknown>): { timeoutMs: number; pollIntervalMs: number } {
  const timeoutMs = optionalIntegerParam(input, "timeoutMs", DEFAULT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = optionalIntegerParam(input, "pollIntervalMs", DEFAULT_WAIT_POLL_INTERVAL_MS);
  return {
    timeoutMs: Math.max(1, timeoutMs),
    pollIntervalMs: Math.max(50, pollIntervalMs)
  };
}

function afterConditions(input: unknown): Record<string, unknown> | undefined {
  const params = optionalObject(input);
  if (params.after === undefined) return undefined;
  const after = expectObject(params.after);
  const waitForText = optionalStringParam(after, "waitForText");
  const waitForPackage = optionalStringParam(after, "waitForPackage");
  if (!waitForText && !waitForPackage) {
    throw new ToolInputError("after must include waitForText and/or waitForPackage.");
  }
  return after;
}

async function runAfterConditions(input: unknown): Promise<ToolResult | undefined> {
  const after = afterConditions(input);
  if (!after) return undefined;
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const timeoutMs = optionalIntegerParam(after, "timeoutMs", DEFAULT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = optionalIntegerParam(after, "pollIntervalMs", DEFAULT_WAIT_POLL_INTERVAL_MS);
  const results: ToolResult = {};
  let success = true;
  const waitForText = optionalStringParam(after, "waitForText");
  if (waitForText) {
    const result = await androidWaitForText({
      deviceId,
      ...target,
      text: waitForText,
      role: optionalStringParam(after, "role"),
      fuzzy: optionalBooleanParam(after, "fuzzy", false),
      timeoutMs,
      pollIntervalMs
    });
    results.waitForText = result;
    success = success && result.success === true;
  }
  const waitForPackage = optionalStringParam(after, "waitForPackage");
  if (waitForPackage) {
    const result = await androidWaitForPackage({ deviceId, ...target, packageName: waitForPackage, timeoutMs, pollIntervalMs });
    results.waitForPackage = result;
    success = success && result.success === true;
  }
  return { success, ...results };
}

function stableSnapshotOptions(input: Record<string, unknown>): { waitForStable: boolean; stableTimeoutMs: number; stablePollIntervalMs: number } {
  return {
    waitForStable: optionalBooleanParam(input, "waitForStable", true),
    stableTimeoutMs: Math.max(1, optionalIntegerParam(input, "stableTimeoutMs", DEFAULT_STABLE_TIMEOUT_MS)),
    stablePollIntervalMs: Math.max(50, optionalIntegerParam(input, "stablePollIntervalMs", DEFAULT_STABLE_POLL_INTERVAL_MS))
  };
}

async function postActionSnapshot(input: {
  deviceId: string;
  target?: DisplayTarget;
  returnSnapshot: boolean;
  waitForStable: boolean;
  stableTimeoutMs: number;
  stablePollIntervalMs: number;
}): Promise<Record<string, unknown>> {
  if (!input.returnSnapshot) {
    return {};
  }
  if (!input.waitForStable) {
    return {
      currentSnapshot: await currentAccessibilitySnapshot(input.deviceId, input.target),
      snapshotStable: false,
      stability: "not_requested",
      snapshotWaitElapsedMs: 0
    };
  }
  const stable = await waitForStableSnapshot({
    deviceId: input.deviceId,
    target: input.target,
    timeoutMs: input.stableTimeoutMs,
    pollIntervalMs: input.stablePollIntervalMs
  });
  return {
    currentSnapshot: stable.snapshot,
    snapshotStable: stable.stability !== "timeout",
    stability: stable.stability,
    snapshotWaitElapsedMs: stable.elapsedMs
  };
}

async function waitForStableSnapshot(options: {
  deviceId: string;
  target?: DisplayTarget;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<{ snapshot: SemanticSnapshot; stability: "strict" | "actionable" | "timeout"; elapsedMs: number }> {
  const start = performance.now();
  let previous = await currentAccessibilitySnapshot(options.deviceId, options.target);
  await sleep(options.pollIntervalMs);
  while (performance.now() - start <= options.timeoutMs) {
    const current = await currentAccessibilitySnapshot(options.deviceId, options.target);
    const elapsedMs = Math.round(performance.now() - start);
    if (current.screenSignature === previous.screenSignature) {
      return { snapshot: current, stability: "strict", elapsedMs };
    }
    if (current.actionableSignature === previous.actionableSignature) {
      return { snapshot: current, stability: "actionable", elapsedMs };
    }
    previous = current;
    await sleep(options.pollIntervalMs);
  }
  return { snapshot: previous, stability: "timeout", elapsedMs: Math.round(performance.now() - start) };
}

async function pollUntil<T>(
  options: { timeoutMs: number; pollIntervalMs: number },
  check: () => Promise<{ done: boolean; data: T }>
): Promise<{ done: boolean; elapsedMs: number; data: T }> {
  const start = performance.now();
  let last: { done: boolean; data: T } | undefined;
  while (performance.now() - start <= options.timeoutMs) {
    last = await check();
    if (last.done) {
      return { done: true, elapsedMs: Math.round(performance.now() - start), data: last.data };
    }
    await sleep(options.pollIntervalMs);
  }
  if (!last) {
    last = await check();
  }
  return { done: last.done, elapsedMs: Math.round(performance.now() - start), data: last.data };
}

function waitResult(
  success: boolean,
  elapsedMs: number,
  options: { timeoutMs: number; pollIntervalMs: number },
  data: Record<string, unknown>,
  successStatus: string,
  timeoutStatus: string
): ToolResult {
  return {
    success,
    status: success ? successStatus : timeoutStatus,
    elapsedMs,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    ...data
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
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

async function androidDumpTree(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const response = await androidBridgeRpc(deviceId, "dumpXml", bridgeDisplayTarget(target));
  const xml = response.xml;
  if (typeof xml !== "string") {
    throw new AndroidBridgeError("Android bridge dumpXml response did not include XML.", { response });
  }
  if (!xml.includes("<hierarchy")) {
    throw new Error("UIAutomator bridge did not return a hierarchy XML document.");
  }
  return response;
}

async function androidDumpCompactForInput(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  return androidDumpCompact(deviceId, displayTargetParams(params));
}

async function androidDumpCompact(deviceId: string, target: DisplayTarget = {}): Promise<ToolResult> {
  return androidBridgeRpc(deviceId, "dumpCompact", bridgeDisplayTarget(target));
}

async function androidTap(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const x = numberParam(params, "x");
  const y = numberParam(params, "y");
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const target = displayTargetParams(params);
  const response = await androidBridgeRpc(deviceId, "tap", { x, y, ...bridgeDisplayTarget(target) });
  const tapResult = normalizeBridgeSuccess(response);
  const snapshotContext = await postActionSnapshot({ deviceId, target, returnSnapshot, ...stableOptions });
  return {
    ...tapResult,
    ...snapshotContext
  };
}

async function androidTapRef(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const snapshotId = stringParam(params, "snapshotId");
  const ref = stringParam(params, "ref");
  const requestedDeviceId = optionalStringParam(params, "deviceId");
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const resolved = await resolveAccessibilityRef(snapshotId, ref, requestedDeviceId, displayTargetParams(params));
  if (!resolved.ok) {
    return refFailureResult(resolved, returnSnapshot);
  }

  const [x, y] = resolved.targetNode.center;
  const target = resolved.cached.sessionId ? { sessionId: resolved.cached.sessionId } : { displayId: resolved.cached.displayId };
  const tapResult = normalizeBridgeSuccess(await androidBridgeRpc(resolved.cached.deviceId, "tap", { x, y, ...bridgeDisplayTarget(target) }));
  const snapshotContext = await postActionSnapshot({ deviceId: resolved.cached.deviceId, target, returnSnapshot, ...stableOptions });
  return {
    ...tapResult,
    status: resolved.status,
    actionStrategy: "coordinate_tap",
    from: nodeRefSummary(resolved.cached.snapshotId, resolved.originalNode),
    target: nodeRefSummary(resolved.status === "fresh" ? resolved.cached.snapshotId : resolved.current.snapshotId, resolved.targetNode),
    ...snapshotContext
  };
}

async function androidFillRef(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const snapshotId = stringParam(params, "snapshotId");
  const ref = stringParam(params, "ref");
  const requestedDeviceId = optionalStringParam(params, "deviceId");
  const text = stringParam(params, "text");
  const pressEnter = optionalBooleanParam(params, "pressEnter", false);
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const resolved = await resolveAccessibilityRef(snapshotId, ref, requestedDeviceId, displayTargetParams(params));
  if (!resolved.ok) {
    return refFailureResult(resolved, returnSnapshot);
  }
  if (!isNodeEditable(resolved.targetNode, resolved.targetNode.role)) {
    return {
      success: false,
      status: "ref_not_editable",
      message: "The resolved accessibility node does not appear to be editable.",
      from: nodeRefSummary(resolved.cached.snapshotId, resolved.originalNode),
      target: nodeRefSummary(resolved.status === "fresh" ? resolved.cached.snapshotId : resolved.current.snapshotId, resolved.targetNode),
      ...(returnSnapshot ? { currentSnapshot: resolved.current } : {})
    };
  }

  const target = resolved.cached.sessionId ? { sessionId: resolved.cached.sessionId } : { displayId: resolved.cached.displayId };
  const result = await inputTextIntoNode(resolved.cached.deviceId, resolved.targetNode, text, pressEnter, target);
  const snapshotContext = await postActionSnapshot({ deviceId: resolved.cached.deviceId, target, returnSnapshot, ...stableOptions });
  return {
    ...result,
    status: resolved.status,
    actionStrategy: "accessibility_set_text",
    from: nodeRefSummary(resolved.cached.snapshotId, resolved.originalNode),
    target: nodeRefSummary(resolved.status === "fresh" ? resolved.cached.snapshotId : resolved.current.snapshotId, resolved.targetNode),
    ...snapshotContext
  };
}

async function androidLongPressRef(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const snapshotId = stringParam(params, "snapshotId");
  const ref = stringParam(params, "ref");
  const requestedDeviceId = optionalStringParam(params, "deviceId");
  const durationMs = params.durationMs === undefined ? 650 : numberParam(params, "durationMs");
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const resolved = await resolveAccessibilityRef(snapshotId, ref, requestedDeviceId, displayTargetParams(params));
  if (!resolved.ok) {
    return refFailureResult(resolved, returnSnapshot);
  }

  const [x, y] = resolved.targetNode.center;
  const steps = Math.max(1, Math.round(durationMs / 5));
  const target = resolved.cached.sessionId ? { sessionId: resolved.cached.sessionId } : { displayId: resolved.cached.displayId };
  const longPressResult = normalizeBridgeSuccess(await androidBridgeRpc(resolved.cached.deviceId, "longPress", { x, y, steps, ...bridgeDisplayTarget(target) }));
  const snapshotContext = await postActionSnapshot({ deviceId: resolved.cached.deviceId, target, returnSnapshot, ...stableOptions });
  return {
    ...longPressResult,
    status: resolved.status,
    actionStrategy: "coordinate_long_press",
    from: nodeRefSummary(resolved.cached.snapshotId, resolved.originalNode),
    target: nodeRefSummary(resolved.status === "fresh" ? resolved.cached.snapshotId : resolved.current.snapshotId, resolved.targetNode),
    ...snapshotContext
  };
}

async function androidPerformActionRef(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const snapshotId = stringParam(params, "snapshotId");
  const ref = stringParam(params, "ref");
  const requestedDeviceId = optionalStringParam(params, "deviceId");
  const action = stringParam(params, "action");
  const text = optionalStringParam(params, "text");
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const resolved = await resolveAccessibilityRef(snapshotId, ref, requestedDeviceId, displayTargetParams(params));
  if (!resolved.ok) {
    return refFailureResult(resolved, returnSnapshot);
  }

  const target = resolved.cached.sessionId ? { sessionId: resolved.cached.sessionId } : { displayId: resolved.cached.displayId };
  const actionResult = await performActionOnNode(resolved.cached.deviceId, resolved.targetNode, action, text, target);
  const snapshotContext = await postActionSnapshot({ deviceId: resolved.cached.deviceId, target, returnSnapshot, ...stableOptions });
  return {
    ...actionResult,
    status: resolved.status,
    actionStrategy: "accessibility_action",
    from: nodeRefSummary(resolved.cached.snapshotId, resolved.originalNode),
    target: nodeRefSummary(resolved.status === "fresh" ? resolved.cached.snapshotId : resolved.current.snapshotId, resolved.targetNode),
    ...snapshotContext
  };
}

async function androidTapText(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const text = stringParam(params, "text");
  const role = optionalStringParam(params, "role");
  const fuzzy = optionalBooleanParam(params, "fuzzy", false);
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const target = displayTargetParams(params);
  const snapshot = await currentAccessibilitySnapshot(deviceId, target);
  return tapUniqueNode(deviceId, findNodesByLocator(snapshot.nodes, { text, role, fuzzy }), snapshot, returnSnapshot, stableOptions, "text");
}

async function androidTapContentDesc(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const contentDesc = stringParam(params, "contentDesc");
  const role = optionalStringParam(params, "role");
  const fuzzy = optionalBooleanParam(params, "fuzzy", false);
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const target = displayTargetParams(params);
  const snapshot = await currentAccessibilitySnapshot(deviceId, target);
  return tapUniqueNode(
    deviceId,
    findNodesByLocator(snapshot.nodes, { contentDesc, role, fuzzy }),
    snapshot,
    returnSnapshot,
    stableOptions,
    "contentDesc"
  );
}

async function androidClick(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const locator = locatorFromParams(params);
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const target = displayTargetParams(params);
  const snapshot = await currentAccessibilitySnapshot(deviceId, target);
  return tapUniqueNode(deviceId, findNodesByLocator(snapshot.nodes, locator), snapshot, returnSnapshot, stableOptions, "locator");
}

async function androidFillNearLabel(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const label = stringParam(params, "label");
  const text = stringParam(params, "text");
  const fuzzy = optionalBooleanParam(params, "fuzzy", false);
  const pressEnter = optionalBooleanParam(params, "pressEnter", false);
  const returnSnapshot = optionalBooleanParam(params, "returnSnapshot", true);
  const stableOptions = stableSnapshotOptions(params);
  const target = displayTargetParams(params);
  const snapshot = await currentAccessibilitySnapshot(deviceId, target);
  const labels = findLabelNodes(snapshot.nodes, label, fuzzy);
  if (labels.length === 0) {
    return noLocatorMatch("label_not_found", "No accessibility label matched.", snapshot, returnSnapshot);
  }
  if (labels.length > 1) {
    return ambiguousLocatorMatch("label_ambiguous", "Multiple accessibility labels matched.", labels, snapshot, returnSnapshot);
  }

  const fields = snapshot.nodes.filter((node) => node.source === "accessibility" && isNodeEditable(node, node.role));
  const ranked = fields
    .map((node) => ({ node, distance: labelFieldDistance(labels[0], node) }))
    .filter((item) => Number.isFinite(item.distance))
    .sort((a, b) => a.distance - b.distance);
  if (ranked.length === 0) {
    return noLocatorMatch("editable_not_found", "No editable accessibility node was found near the label.", snapshot, returnSnapshot);
  }
  const best = ranked[0];
  const tied = ranked.filter((item) => Math.abs(item.distance - best.distance) < 24);
  if (tied.length > 1) {
    return ambiguousLocatorMatch(
      "editable_ambiguous",
      "Multiple editable accessibility nodes were similarly close to the label.",
      tied.map((item) => item.node),
      snapshot,
      returnSnapshot
    );
  }

  const result = await inputTextIntoNode(deviceId, best.node, text, pressEnter, target);
  const snapshotContext = await postActionSnapshot({ deviceId, target, returnSnapshot, ...stableOptions });
  return {
    ...result,
    status: "filled",
    actionStrategy: "accessibility_set_text",
    label: nodeRefSummary(snapshot.snapshotId, labels[0]),
    target: nodeRefSummary(snapshot.snapshotId, best.node),
    ...snapshotContext
  };
}

async function androidSwipe(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const x1 = numberParam(params, "x1");
  const y1 = numberParam(params, "y1");
  const x2 = numberParam(params, "x2");
  const y2 = numberParam(params, "y2");
  const durationMs = params.durationMs === undefined ? 300 : numberParam(params, "durationMs");
  const steps = params.steps === undefined ? Math.max(1, Math.round(durationMs / 5)) : positiveNumberParam(params, "steps");
  const target = displayTargetParams(params);
  const response = await androidBridgeRpc(deviceId, "swipe", { x1, y1, x2, y2, steps, ...bridgeDisplayTarget(target) });
  return normalizeBridgeSuccess({ ...response, steps });
}

async function androidInputText(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const text = stringParam(params, "text");
  const selector = optionalSelectorParam(params, "selector");
  const pressEnter = optionalBooleanParam(params, "pressEnter", false);
  const target = displayTargetParams(params);

  if (selector && selectorHasAnyField(selector)) {
    const response = await androidBridgeRpc(deviceId, "inputText", {
      text,
      ...bridgeDisplayTarget(target),
      ...flattenSelector(selector)
    });
    const result = normalizeBridgeSuccess(response);
    if (pressEnter) {
      await androidBridgeRpc(deviceId, "key", { key: "ENTER", ...bridgeDisplayTarget(target) });
    }
    return result;
  }

  const response = await androidBridgeRpc(deviceId, "inputText", { text, ...bridgeDisplayTarget(target) });
  const result = normalizeBridgeSuccess(response);
  if (pressEnter) {
    await androidBridgeRpc(deviceId, "key", { key: "ENTER", ...bridgeDisplayTarget(target) });
  }
  return result;
}

async function androidPerformAction(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const action = stringParam(params, "action");
  const text = optionalStringParam(params, "text");
  const selector = optionalSelectorParam(params, "selector");
  const target = displayTargetParams(params);
  if (!selector || !selectorHasAnyField(selector)) {
    throw new ToolInputError("selector is required and must identify a node.");
  }
  const response = await androidBridgeRpc(deviceId, "performAction", {
    action,
    ...(text !== undefined ? { text } : {}),
    ...bridgeDisplayTarget(target),
    ...flattenSelector(selector)
  });
  return normalizeBridgeSuccess(response);
}

async function androidLongPress(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const x = numberParam(params, "x");
  const y = numberParam(params, "y");
  const durationMs = params.durationMs === undefined ? 650 : numberParam(params, "durationMs");
  const steps = Math.max(1, Math.round(durationMs / 5));
  const target = displayTargetParams(params);
  const response = await androidBridgeRpc(deviceId, "longPress", { x, y, steps, ...bridgeDisplayTarget(target) });
  return normalizeBridgeSuccess({ ...response, durationMs, steps });
}

async function androidKey(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const key = stringParam(params, "key").toUpperCase();
  const keycode = KEYCODES[key];
  if (!keycode) {
    throw new ToolInputError(`key must be one of: ${Object.keys(KEYCODES).join(", ")}.`);
  }
  const target = displayTargetParams(params);
  const response = await androidBridgeRpc(deviceId, "key", { key, ...bridgeDisplayTarget(target) });
  return normalizeBridgeSuccess({ ...response, key, keycode });
}

async function androidGoHome(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const response = await androidBridgeRpc(deviceId, "key", { key: "HOME", ...bridgeDisplayTarget(target) });
  return normalizeBridgeSuccess({ ...response, key: "HOME", keycode: KEYCODES.HOME });
}

function requireDefaultDisplay(target: DisplayTarget, toolName: string): void {
  if (target.sessionId || (target.displayId !== undefined && target.displayId !== 0)) {
    throw new ToolInputError(`${toolName} supports display 0 only.`);
  }
}

async function androidOpenNotifications(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  requireDefaultDisplay(displayTargetParams(params), "android_open_notifications");
  await adbTextForDevice(deviceId, ["shell", "cmd", "statusbar", "expand-notifications"]);
  return { success: true, status: "notifications_opened", deviceId, displayId: 0 };
}

async function androidOpenQuickSettings(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  requireDefaultDisplay(displayTargetParams(params), "android_open_quick_settings");
  await adbTextForDevice(deviceId, ["shell", "cmd", "statusbar", "expand-settings"]);
  return { success: true, status: "quick_settings_opened", deviceId, displayId: 0 };
}

async function androidCloseKeyboard(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const response = await androidBridgeRpc(deviceId, "key", { key: "ESCAPE", ...bridgeDisplayTarget(target) });
  return normalizeBridgeSuccess({ ...response, status: "keyboard_close_requested", key: "ESCAPE", keycode: KEYCODES.ESCAPE });
}

async function androidGrantPermissionDialog(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const preferred = optionalEnumParam(params, "choice", ["while_using", "once", "allow"] as const, "while_using");
  const labelGroups: Record<typeof preferred, string[]> = {
    while_using: ["While using the app", "While using this app", "Allow only while using the app"],
    once: ["Only this time", "Just once"],
    allow: ["Allow", "OK"]
  };
  const snapshot = await currentAccessibilitySnapshot(deviceId, target);
  for (const label of labelGroups[preferred]) {
    const matches = snapshot.nodes.filter((node) => node.source === "accessibility" && (node.text === label || node.contentDesc === label));
    if (matches.length === 1) {
      return tapUniqueNode(deviceId, matches, snapshot, true, stableSnapshotOptions(params), "permission");
    }
  }
  return { success: false, status: "permission_dialog_not_found", choice: preferred, currentSnapshot: snapshot };
}

async function androidOpenRecents(input: unknown): Promise<ToolResult> {
  return androidKey({ ...optionalObject(input), key: "APP_SWITCH" });
}

async function androidSwitchRecentApp(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  const first = await androidBridgeRpc(deviceId, "key", { key: "APP_SWITCH", ...bridgeDisplayTarget(target) });
  await sleep(150);
  const second = await androidBridgeRpc(deviceId, "key", { key: "APP_SWITCH", ...bridgeDisplayTarget(target) });
  return normalizeBridgeSuccess({ ...second, firstSuccess: first.success, status: "recent_app_switch_requested", key: "APP_SWITCH" });
}

async function androidCurrentApp(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  if (hasDisplayTarget(target)) {
    const snapshot = await currentAccessibilitySnapshot(deviceId, target);
    return { success: true, deviceId, packageName: snapshot.packageName, displayId: snapshot.displayId, ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}) };
  }
  const response = await androidBridgeRpc(deviceId, "currentApp");
  return {
    ...response,
    deviceId,
    packageName: typeof response.packageName === "string" ? response.packageName : undefined
  };
}

async function androidWaitForPackage(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const packageName = stringParam(params, "packageName");
  const wait = waitOptions(params);
  const target = displayTargetParams(params);
  const result = await pollUntil(wait, async () => {
    const current = await androidCurrentApp({ deviceId, ...target });
    return {
      done: current.packageName === packageName,
      data: { currentApp: current }
    };
  });
  return waitResult(result.done, result.elapsedMs, wait, result.data, "package_found", "package_timeout");
}

async function androidWaitForText(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const text = stringParam(params, "text");
  const role = optionalStringParam(params, "role");
  const fuzzy = optionalBooleanParam(params, "fuzzy", false);
  const wait = waitOptions(params);
  const target = displayTargetParams(params);
  const result = await pollUntil(wait, async () => {
    const snapshot = await currentAccessibilitySnapshot(deviceId, target);
    const matches = findNodesByLocator(snapshot.nodes, { text, role, fuzzy });
    return {
      done: matches.length > 0,
      data: {
        currentSnapshot: snapshot,
        matches: matches.slice(0, 10).map((node) => nodeRefSummary(snapshot.snapshotId, node))
      }
    };
  });
  return waitResult(result.done, result.elapsedMs, wait, result.data, "text_found", "text_timeout");
}

async function androidWaitForRefGone(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const snapshotId = stringParam(params, "snapshotId");
  const ref = stringParam(params, "ref");
  const requestedDeviceId = optionalStringParam(params, "deviceId");
  const requestedTarget = displayTargetParams(params);
  const cached = snapshotCache.get(snapshotId);
  if (!cached) throw new ToolInputError("The requested snapshotId is no longer cached. Call android_get_semantic_screen again.");
  if (requestedDeviceId && requestedDeviceId !== cached.deviceId) throw new ToolInputError(`snapshotId belongs to device '${cached.deviceId}', not '${requestedDeviceId}'.`);
  const cachedTarget = cached.sessionId ? { sessionId: cached.sessionId } : { displayId: cached.displayId };
  if (hasDisplayTarget(requestedTarget)) {
    const requestedIdentity = requestedTarget.sessionId ?? `display-${requestedTarget.displayId ?? 0}`;
    const cachedIdentity = cached.sessionId ?? `display-${cached.displayId}`;
    if (requestedIdentity !== cachedIdentity) throw new ToolInputError(`snapshotId belongs to '${cachedIdentity}', not '${requestedIdentity}'.`);
  }
  const original = cached.nodes.find((node) => node.ref === ref);
  if (!original) throw new ToolInputError(`ref '${ref}' was not found in snapshot '${snapshotId}'.`);
  if (original.source !== "accessibility") throw new ToolInputError("android_wait_for_ref_gone supports accessibility refs only.");
  const wait = waitOptions(params);
  const result = await pollUntil(wait, async () => {
    const snapshot = await currentAccessibilitySnapshot(cached.deviceId, cachedTarget);
    if (snapshot.screenSignature === cached.screenSignature) {
      return { done: false, data: { currentSnapshot: snapshot, matched: nodeRefSummary(snapshot.snapshotId, original) } };
    }
    const relocated = relocateAccessibilityNode(original, snapshot.nodes);
    const gone = !relocated.node && !relocated.candidates;
    return {
      done: gone,
      data: {
        currentSnapshot: snapshot,
        ...(relocated.node ? { matched: nodeRefSummary(snapshot.snapshotId, relocated.node) } : {}),
        ...(relocated.candidates ? { candidates: relocated.candidates } : {})
      }
    };
  });
  return waitResult(result.done, result.elapsedMs, wait, result.data, "ref_gone", "ref_still_present");
}

async function androidWaitForScreenChange(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const requestedDeviceId = optionalStringParam(params, "deviceId");
  const wait = waitOptions(params);
  const snapshotId = optionalStringParam(params, "snapshotId");
  const screenSignature = optionalStringParam(params, "screenSignature");
  const requestedTarget = displayTargetParams(params);
  const cached = snapshotId ? snapshotCache.get(snapshotId) : undefined;
  if (snapshotId && !cached && !screenSignature) {
    throw new ToolInputError("The requested snapshotId is no longer cached. Call android_get_semantic_screen again.");
  }
  const deviceId = cached?.deviceId ?? (await deviceManager.resolveDeviceId({ ...(requestedDeviceId ? { deviceId: requestedDeviceId } : {}) }));
  if (requestedDeviceId && cached && requestedDeviceId !== cached.deviceId) {
    throw new ToolInputError(`snapshotId belongs to device '${cached.deviceId}', not '${requestedDeviceId}'.`);
  }
  const target = cached
    ? (cached.sessionId ? { sessionId: cached.sessionId } : { displayId: cached.displayId })
    : requestedTarget;
  if (cached && hasDisplayTarget(requestedTarget)) {
    const requestedIdentity = requestedTarget.sessionId ?? `display-${requestedTarget.displayId ?? 0}`;
    const cachedIdentity = cached.sessionId ?? `display-${cached.displayId}`;
    if (requestedIdentity !== cachedIdentity) throw new ToolInputError(`snapshotId belongs to '${cachedIdentity}', not '${requestedIdentity}'.`);
  }
  let baseline = screenSignature;
  if (!baseline && snapshotId) {
    baseline = cached?.screenSignature;
  }
  if (!baseline) {
    baseline = (await currentAccessibilitySnapshot(deviceId, target)).screenSignature;
  }

  const result = await pollUntil(wait, async () => {
    const snapshot = await currentAccessibilitySnapshot(deviceId, target);
    return {
      done: snapshot.screenSignature !== baseline,
      data: { baselineScreenSignature: baseline, currentSnapshot: snapshot }
    };
  });
  return waitResult(result.done, result.elapsedMs, wait, result.data, "screen_changed", "screen_change_timeout");
}

async function androidBridgePing(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  return androidBridgeRpc(deviceId, "ping");
}

async function androidBridgeExit(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const bridge = deviceManager.runningBridge(deviceId);
  if (!bridge) {
    return { success: true, alreadyStopped: true, deviceId };
  }
  const response = await deviceManager.runOnDevice(deviceId, () => bridgeRpcOnPort(deviceId, bridge.port, "exit"));
  deviceManager.stopBridge(deviceId);
  return normalizeBridgeSuccess(response);
}

async function androidProbeVirtualDisplay(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const width = (params as Record<string, unknown>).width ?? 1024;
  const height = (params as Record<string, unknown>).height ?? 768;
  const dpi = (params as Record<string, unknown>).dpi ?? 160;
  const response = await androidBridgeRpc(deviceId, "probeVirtualDisplay", {
    width: Number(width),
    height: Number(height),
    dpi: Number(dpi)
  });
  return normalizeBridgeSuccess(response);
}

async function androidCreateVirtualDisplay(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const width = optionalIntegerParam(params, "width", DEFAULT_VIRTUAL_DISPLAY_WIDTH);
  const height = optionalIntegerParam(params, "height", DEFAULT_VIRTUAL_DISPLAY_HEIGHT);
  const dpi = optionalIntegerParam(params, "dpi", DEFAULT_VIRTUAL_DISPLAY_DPI);
  const systemDecorations = optionalBooleanParam(params, "systemDecorations", true);
  const destroyContentOnRemoval = optionalBooleanParam(params, "destroyContentOnRemoval", true);
  const displayImePolicy = params.displayImePolicy === undefined ? undefined : optionalIntegerParam(params, "displayImePolicy", 0);
  if (width < 100 || height < 100 || dpi < 80) {
    throw new ToolInputError("width and height must be at least 100, and dpi must be at least 80.");
  }
  const response = await androidBridgeRpc(deviceId, "createVirtualDisplay", { width, height, dpi, systemDecorations, destroyContentOnRemoval, ...(displayImePolicy !== undefined ? { displayImePolicy } : {}) });
  invalidateVirtualSessions(deviceId, "virtual_display_recreated");
  if (typeof response.sessionId === "string") {
    activeVirtualSessions.set(response.sessionId, deviceId);
    staleVirtualSessions.delete(response.sessionId);
  }
  return normalizeBridgeSuccess({ ...response, deviceId });
}

async function androidDestroyVirtualDisplay(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const target = displayTargetParams(params);
  if (!hasDisplayTarget(target)) {
    throw new ToolInputError("Provide sessionId or displayId.");
  }
  if (target.displayId === 0) {
    throw new ToolInputError("displayId 0 cannot be destroyed.");
  }
  const response = await androidBridgeRpc(deviceId, "destroyVirtualDisplay", {
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    ...(target.displayId !== undefined ? { displayId: target.displayId } : {})
  });
  const destroyedSessionId = typeof response.sessionId === "string" ? response.sessionId : target.sessionId;
  invalidateSnapshots(deviceId, destroyedSessionId);
  if (destroyedSessionId) {
    activeVirtualSessions.delete(destroyedSessionId);
    staleVirtualSessions.set(destroyedSessionId, "virtual_display_not_found");
  }
  return normalizeBridgeSuccess({ ...response, deviceId });
}

async function androidListDisplays(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const response = await androidBridgeRpc(deviceId, "listDisplays");
  return normalizeBridgeSuccess({ ...response, deviceId });
}

function normalizeBridgeSuccess(response: Record<string, unknown>): ToolResult {
  return {
    ...response,
    success: response.success === true
  };
}

async function androidListDevices(input: unknown): Promise<ToolResult> {
  optionalObject(input);
  const devices = await deviceManager.listDevices();
  return {
    devices,
    count: devices.length,
    authorizedCount: devices.filter((device) => device.state === "device").length
  };
}

async function androidListApps(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  const deviceId = await deviceIdParam(params);
  const query = optionalStringParam(params, "query");
  const includeSystem = optionalBooleanParam(params, "includeSystem", true);
  optionalBooleanParam(params, "resolveLabels", false);
  const apps = await getLauncherApps(deviceId);
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
    deviceId,
    apps: filtered,
    count: filtered.length,
    localizationNote:
      "App names are derived on the Android device from package and launcher activity names. Use applicationId for deterministic launching."
  };
}

async function androidLaunchApp(input: unknown): Promise<ToolResult> {
  const params = expectObject(input);
  const deviceId = await deviceIdParam(params);
  const applicationId = optionalStringParam(params, "applicationId");
  const appName = optionalStringParam(params, "appName");
  const allowSubstring = optionalBooleanParam(params, "allowSubstring", true);
  optionalBooleanParam(params, "resolveLabels", true);
  const displayTarget = displayTargetParams(params);

  if (!applicationId && !appName) {
    throw new ToolInputError("Provide applicationId or appName.");
  }
  if (applicationId && appName) {
    throw new ToolInputError("Provide only one of applicationId or appName.");
  }

  const apps = await getLauncherApps(deviceId);
  let target = applicationId ? findAppByApplicationId(apps, applicationId) : findAppByName(apps, appName as string, allowSubstring, false);
  if (!target) {
    throw new ToolInputError(
      `No launcher app matched appName '${appName}'. Call android_list_apps, then launch by applicationId.`
    );
  }
  const response = await androidBridgeRpc(deviceId, "launchApp", {
    applicationId: target.applicationId,
    ...(displayTarget.sessionId ? { sessionId: displayTarget.sessionId } : {}),
    ...(displayTarget.displayId !== undefined ? { displayId: displayTarget.displayId } : {})
  });
  const result = normalizeBridgeSuccess(response);

  return {
    ...result,
    deviceId,
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

async function getLauncherApps(deviceId: string): Promise<AndroidApp[]> {
  const response = await androidBridgeRpc(deviceId, "listApps");
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
const afterActionSchema = {
  type: "object",
  properties: {
    waitForText: { type: "string", minLength: 1 },
    waitForPackage: { type: "string", minLength: 1 },
    role: { type: "string", minLength: 1 },
    fuzzy: { type: "boolean", default: false },
    timeoutMs: { type: "integer", minimum: 1, default: DEFAULT_WAIT_TIMEOUT_MS },
    pollIntervalMs: { type: "integer", minimum: 50, default: DEFAULT_WAIT_POLL_INTERVAL_MS }
  },
  additionalProperties: false
};
const stableSnapshotProperties = {
  returnSnapshot: { type: "boolean", default: true },
  waitForStable: { type: "boolean", default: true },
  stableTimeoutMs: { type: "integer", minimum: 1, default: DEFAULT_STABLE_TIMEOUT_MS },
  stablePollIntervalMs: { type: "integer", minimum: 50, default: DEFAULT_STABLE_POLL_INTERVAL_MS },
  after: afterActionSchema
};
const deviceProperties = {
  deviceId: { type: "string", minLength: 1, description: "ADB device serial. Omit only when exactly one authorized device is connected." }
};
const displayTargetProperties = {
  sessionId: { type: "string", minLength: 1, description: "MCP-owned virtual display session ID." },
  displayId: { type: "integer", minimum: 0, description: "Android display ID. Omit for the default physical display." }
};

function sanitizeTraceValue(value: unknown, key = ""): unknown {
  if (key === "pngBase64" || key === "rawOcr" || key === "rawVision") return "[omitted]";
  if (key === "url" && typeof value === "string" && value.includes("#token=")) return value.replace(/#token=.*/, "#token=[redacted]");
  if ((key === "text" || key === "targetText") && typeof value === "string") return `[redacted:${value.length}]`;
  if (Array.isArray(value)) return value.map((item) => sanitizeTraceValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitizeTraceValue(child, childKey)]));
  }
  return value;
}

async function recordTraceEvent(toolName: string, input: unknown, result: unknown, error: Error | undefined, elapsedMs: number): Promise<void> {
  const trace = activeTrace;
  if (!trace || toolName.startsWith("android_trace_")) return;
  const step = ++trace.step;
  const baseName = `${String(step).padStart(4, "0")}-${safeFileName(toolName)}`;
  const event: Record<string, unknown> = {
    step,
    timestamp: new Date().toISOString(),
    tool: toolName,
    elapsedMs,
    input: sanitizeTraceValue(input),
    ...(error ? { error: { name: error.name, message: error.message } } : { result: sanitizeTraceValue(result) })
  };
  const imagePath = result && typeof result === "object" && typeof (result as Record<string, unknown>).imagePath === "string"
    ? (result as Record<string, unknown>).imagePath as string
    : undefined;
  if (imagePath) {
    const traceImage = join(trace.directory, `${baseName}.png`);
    try {
      await copyFile(imagePath, traceImage);
      event.screenshotPath = traceImage;
    } catch (copyError) {
      event.screenshotCopyError = (copyError as Error).message;
    }
  }
  await writeFile(join(trace.directory, `${baseName}.json`), `${JSON.stringify(event, null, 2)}\n`, "utf8");
  await appendFile(join(trace.directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

async function androidTraceStart(input: unknown): Promise<ToolResult> {
  const params = optionalObject(input);
  if (activeTrace) throw new ToolInputError(`Trace '${activeTrace.traceId}' is already active.`);
  const traceId = optionalStringParam(params, "traceId") ?? `trace-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const directory = join(TRACE_ROOT, safeFileName(traceId));
  await mkdir(directory, { recursive: true });
  activeTrace = { traceId, directory, startedAt: new Date().toISOString(), step: 0 };
  await writeFile(join(directory, "trace.json"), `${JSON.stringify({ traceId, startedAt: activeTrace.startedAt, status: "active" }, null, 2)}\n`, "utf8");
  return { success: true, status: "trace_started", traceId, directory, startedAt: activeTrace.startedAt };
}

async function androidTraceStop(): Promise<ToolResult> {
  const trace = activeTrace;
  if (!trace) return { success: true, status: "trace_not_active" };
  const stoppedAt = new Date().toISOString();
  activeTrace = undefined;
  await writeFile(join(trace.directory, "trace.json"), `${JSON.stringify({ traceId: trace.traceId, startedAt: trace.startedAt, stoppedAt, status: "stopped", stepCount: trace.step }, null, 2)}\n`, "utf8");
  return { success: true, status: "trace_stopped", traceId: trace.traceId, directory: trace.directory, startedAt: trace.startedAt, stoppedAt, stepCount: trace.step };
}

async function androidTraceStatus(): Promise<ToolResult> {
  return activeTrace
    ? { success: true, status: "trace_active", ...activeTrace }
    : { success: true, status: "trace_not_active" };
}

function capabilityGroupForTool(name: string): CapabilityGroup {
  if (name.startsWith("android_trace_")) return "trace";
  if (name.startsWith("android_viewer_")) return "debug";
  if (name === "android_ocr_screen") return "ocr";
  if (["android_current_app", "android_wait_for_package", "android_list_apps", "android_launch_app"].includes(name)) return "apps";
  if (["android_list_devices", "android_bridge_ping", "android_bridge_exit", "android_probe_virtual_display", "android_list_displays", "android_dump_tree", "android_dump_compact"].includes(name)) return "debug";
  if (["android_tap", "android_long_press"].includes(name)) return "vision";
  return "core";
}

async function androidCapabilities(): Promise<ToolResult> {
  return {
    success: true,
    enabled: ALL_CAPABILITY_GROUPS.filter((group) => enabledCapabilityGroups.has(group)),
    available: ALL_CAPABILITY_GROUPS,
    configuredBy: process.env.ANDROID_MCP_CAPABILITIES ? "ANDROID_MCP_CAPABILITIES" : "default_all"
  };
}

const tools: ToolDefinition[] = [
  {
    name: "android_capabilities",
    description: "List available and currently enabled MCP capability groups.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidCapabilities
  },
  {
    name: "android_trace_start",
    description: "Start a local agent-debugging trace that records sanitized tool steps, results, snapshots, and screenshots.",
    inputSchema: { type: "object", properties: { traceId: { type: "string", minLength: 1 } }, additionalProperties: false },
    handler: androidTraceStart
  },
  {
    name: "android_trace_stop",
    description: "Stop the active local trace and return its directory.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidTraceStop
  },
  {
    name: "android_trace_status",
    description: "Return whether a local trace is active and its current step count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidTraceStatus
  },
  {
    name: "android_viewer_start",
    description: "Start a token-authenticated local Viewer inside this MCP process so it shares bridge, snapshot, and safe-ref state.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        port: { type: "integer", minimum: 0, maximum: 65535, default: 0, description: "Loopback HTTP port. Use 0 to allocate an available port." },
        allowActions: { type: "boolean", default: false, description: "Allow explicit accessibility-ref taps from the Viewer. OCR/vision refs remain observation-only." },
        ocrMode: { type: "string", enum: ["auto", "force", "off"], default: "auto" },
        visionMode: { type: "string", enum: ["auto", "force", "off"], default: "auto" },
        maxNodes: { type: "integer", minimum: 1, maximum: 500, default: 200 }
      },
      additionalProperties: false
    },
    handler: androidViewerStart
  },
  {
    name: "android_viewer_status",
    description: "Return the current in-process local Viewer status and URL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidViewerStatus
  },
  {
    name: "android_viewer_stop",
    description: "Stop the current in-process local Viewer without stopping the Android bridge.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidViewerStop
  },
  {
    name: "android_list_devices",
    description: "List Android devices visible to ADB, including authorization and managed bridge state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: androidListDevices
  },
  {
    name: "android_bridge_ping",
    description: "Check that the persistent on-device UIAutomator bridge is reachable through adb forward.",
    inputSchema: { type: "object", properties: deviceProperties, additionalProperties: false },
    handler: androidBridgePing
  },
  {
    name: "android_bridge_exit",
    description: "Ask the persistent on-device UIAutomator bridge to stop serving requests.",
    inputSchema: { type: "object", properties: deviceProperties, additionalProperties: false },
    handler: androidBridgeExit
  },
  {
    name: "android_probe_virtual_display",
    description: "PROBE: Attempt to create a secondary virtual display from the UIAutomator bridge. Returns display ID and info on success, or detailed error on failure.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        width: { type: "integer", minimum: 100, default: 1024 },
        height: { type: "integer", minimum: 100, default: 768 },
        dpi: { type: "integer", minimum: 80, default: 160 }
      },
      additionalProperties: false
    },
    handler: androidProbeVirtualDisplay
  },
  {
    name: "android_create_virtual_display",
    description: "Create one MCP-owned Android 14+ virtual display and return its sessionId and displayId.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        width: { type: "integer", minimum: 100, default: DEFAULT_VIRTUAL_DISPLAY_WIDTH },
        height: { type: "integer", minimum: 100, default: DEFAULT_VIRTUAL_DISPLAY_HEIGHT },
        dpi: { type: "integer", minimum: 80, default: DEFAULT_VIRTUAL_DISPLAY_DPI },
        systemDecorations: { type: "boolean", default: true },
        destroyContentOnRemoval: { type: "boolean", default: true },
        displayImePolicy: {
          type: "integer",
          minimum: 0,
          maximum: 1,
          description: "Optional Android display IME policy: 0 local, 1 fallback to default display. Omit to keep the system default."
        }
      },
      additionalProperties: false
    },
    handler: androidCreateVirtualDisplay
  },
  {
    name: "android_destroy_virtual_display",
    description: "Destroy an MCP-owned virtual display by sessionId or displayId.",
    inputSchema: {
      type: "object",
      properties: { ...deviceProperties, ...displayTargetProperties },
      additionalProperties: false
    },
    handler: androidDestroyVirtualDisplay
  },
  {
    name: "android_list_displays",
    description: "List Android displays visible to the bridge and mark MCP-owned virtual displays.",
    inputSchema: { type: "object", properties: deviceProperties, additionalProperties: false },
    handler: androidListDisplays
  },
  {
    name: "android_current_app",
    description: "Return the current foreground Android package reported by the on-device bridge.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties }, additionalProperties: false },
    handler: androidCurrentApp
  },
  {
    name: "android_wait_for_package",
    description: "Poll the foreground package until it matches the requested package name or times out.",
    inputSchema: {
      type: "object",
      required: ["packageName"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        packageName: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1, default: DEFAULT_WAIT_TIMEOUT_MS },
        pollIntervalMs: { type: "integer", minimum: 50, default: DEFAULT_WAIT_POLL_INTERVAL_MS }
      },
      additionalProperties: false
    },
    handler: androidWaitForPackage
  },
  {
    name: "android_wait_for_text",
    description: "Poll the current accessibility snapshot until at least one node matches text.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        text: { type: "string", minLength: 1 },
        role: { type: "string", minLength: 1 },
        fuzzy: { type: "boolean", default: false },
        timeoutMs: { type: "integer", minimum: 1, default: DEFAULT_WAIT_TIMEOUT_MS },
        pollIntervalMs: { type: "integer", minimum: 50, default: DEFAULT_WAIT_POLL_INTERVAL_MS }
      },
      additionalProperties: false
    },
    handler: androidWaitForText
  },
  {
    name: "android_wait_for_ref_gone",
    description: "Poll until an accessibility ref from a cached snapshot can no longer be found on the same display.",
    inputSchema: {
      type: "object",
      required: ["snapshotId", "ref"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        snapshotId: { type: "string", minLength: 1 },
        ref: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1, default: DEFAULT_WAIT_TIMEOUT_MS },
        pollIntervalMs: { type: "integer", minimum: 50, default: DEFAULT_WAIT_POLL_INTERVAL_MS }
      },
      additionalProperties: false
    },
    handler: androidWaitForRefGone
  },
  {
    name: "android_wait_for_screen_change",
    description: "Poll accessibility snapshots until the screen signature differs from a baseline snapshot or signature.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        snapshotId: { type: "string", minLength: 1 },
        screenSignature: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1, default: DEFAULT_WAIT_TIMEOUT_MS },
        pollIntervalMs: { type: "integer", minimum: 50, default: DEFAULT_WAIT_POLL_INTERVAL_MS }
      },
      additionalProperties: false
    },
    handler: androidWaitForScreenChange
  },
  {
    name: "android_screenshot",
    description: "Capture the current Android screen with adb exec-out screencap -p and return a local PNG path plus dimensions.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        retain: {
          type: "boolean",
          default: false,
          description: "When false, overwrite one stable temp screenshot. When true, keep this screenshot in a unique temp directory."
        },
        timeoutMs: { type: "integer", minimum: 1, default: DEFAULT_VIRTUAL_FRAME_TIMEOUT_MS, description: "Bridge frame timeout for virtual display screenshots." }
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
      properties: { ...deviceProperties, ...displayTargetProperties, ...ocrCommonProperties },
      additionalProperties: false
    },
    handler: androidOcrScreen
  },
  {
    name: "android_get_semantic_screen",
    description: "Return a unified compact screen model from accessibility nodes, with optional or automatic OCR and visual-icon fallback for sparse trees.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        ocrMode: { type: "string", enum: ["auto", "force", "off"], default: "auto" },
        visionMode: { type: "string", enum: ["auto", "force", "off"], default: "auto", description: "Visual icon/button detection mode. auto: run when accessibility tree is sparse. force: always run. off: never run." },
        includeScreenshot: { type: "boolean", default: true },
        includeRawTree: { type: "boolean", default: false },
        includeRawVision: { type: "boolean", default: false },
        ...ocrCommonProperties
      },
      additionalProperties: false
    },
    handler: androidGetSemanticScreen
  },
  {
    name: "android_get_ui_outline",
    description: "Return a token-efficient zoned UI outline with the same snapshot-local refs used by semantic actions.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        ocrMode: { type: "string", enum: ["auto", "force", "off"], default: "auto" },
        visionMode: { type: "string", enum: ["auto", "force", "off"], default: "auto", description: "Visual icon/button detection mode. auto: run when accessibility is sparse. force: always run. off: never run." },
        includeScreenshot: { type: "boolean", default: false },
        includeEntries: { type: "boolean", default: false, description: "Also return structured entries. Omit for the smallest response." },
        maxLines: { type: "integer", minimum: 1, maximum: 500, default: 80 },
        ...ocrCommonProperties
      },
      additionalProperties: false
    },
    handler: androidGetUiOutline
  },
  {
    name: "android_dump_tree",
    description: "Dump the current Android accessibility tree as XML through the persistent on-device UIAutomator bridge.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties }, additionalProperties: false },
    handler: androidDumpTree
  },
  {
    name: "android_dump_compact",
    description: "Return a compact accessibility-node list from the persistent on-device UIAutomator bridge.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties }, additionalProperties: false },
    handler: androidDumpCompactForInput
  },
  {
    name: "android_tap",
    description: "Tap a screen coordinate through the persistent on-device UIAutomator bridge.",
    inputSchema: {
      type: "object",
      required: ["x", "y"],
      properties: { ...deviceProperties, ...displayTargetProperties, x: integerSchema, y: integerSchema, ...stableSnapshotProperties },
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
        ...deviceProperties,
        ...displayTargetProperties,
        snapshotId: { type: "string", minLength: 1 },
        ref: { type: "string", minLength: 1 },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidTapRef
  },
  {
    name: "android_fill_ref",
    description: "Fill an editable accessibility node by snapshot-local ref, with stale-screen detection and conservative relocation. OCR refs are rejected.",
    inputSchema: {
      type: "object",
      required: ["snapshotId", "ref", "text"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        snapshotId: { type: "string", minLength: 1 },
        ref: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        pressEnter: { type: "boolean", default: false },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidFillRef
  },
  {
    name: "android_long_press_ref",
    description: "Long press an accessibility node by snapshot-local ref, with stale-screen detection and conservative relocation. OCR refs are rejected.",
    inputSchema: {
      type: "object",
      required: ["snapshotId", "ref"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        snapshotId: { type: "string", minLength: 1 },
        ref: { type: "string", minLength: 1 },
        durationMs: { ...integerSchema, default: 650 },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidLongPressRef
  },
  {
    name: "android_perform_action_ref",
    description: "Execute an accessibility action on a node by snapshot-local ref, with stale-screen detection and conservative relocation. OCR refs are rejected.",
    inputSchema: {
      type: "object",
      required: ["snapshotId", "ref", "action"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        snapshotId: { type: "string", minLength: 1 },
        ref: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1, description: "Text used by the set_text action." },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidPerformActionRef
  },
  {
    name: "android_tap_text",
    description: "Tap the unique current accessibility node matching text. OCR nodes are not action targets.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        text: { type: "string", minLength: 1 },
        role: { type: "string", minLength: 1 },
        fuzzy: { type: "boolean", default: false },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidTapText
  },
  {
    name: "android_tap_content_desc",
    description: "Tap the unique current accessibility node matching content description. OCR nodes are not action targets.",
    inputSchema: {
      type: "object",
      required: ["contentDesc"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        contentDesc: { type: "string", minLength: 1 },
        role: { type: "string", minLength: 1 },
        fuzzy: { type: "boolean", default: false },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidTapContentDesc
  },
  {
    name: "android_click",
    description: "Tap the unique current accessibility node matching a small locator object. OCR nodes are not action targets.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        resourceId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        contentDesc: { type: "string", minLength: 1 },
        role: { type: "string", minLength: 1 },
        className: { type: "string", minLength: 1 },
        fuzzy: { type: "boolean", default: false },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidClick
  },
  {
    name: "android_fill_near_label",
    description: "Fill the unique editable accessibility node spatially associated with a visible accessibility label.",
    inputSchema: {
      type: "object",
      required: ["label", "text"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        label: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1 },
        fuzzy: { type: "boolean", default: false },
        pressEnter: { type: "boolean", default: false },
        ...stableSnapshotProperties
      },
      additionalProperties: false
    },
    handler: androidFillNearLabel
  },
  {
    name: "android_swipe",
    description: "Swipe between two screen coordinates through the persistent on-device UIAutomator bridge.",
    inputSchema: {
      type: "object",
      required: ["x1", "y1", "x2", "y2"],
      properties: {
        ...deviceProperties,
        ...displayTargetProperties,
        x1: integerSchema,
        y1: integerSchema,
        x2: integerSchema,
        y2: integerSchema,
        durationMs: { ...integerSchema, default: 300 },
        steps: { ...positiveIntegerSchema, description: "Optional UIAutomator swipe steps. Defaults to durationMs / 5." },
        after: afterActionSchema
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
        ...deviceProperties,
        ...displayTargetProperties,
        text: { type: "string", minLength: 1 },
        selector: selectorSchema,
        pressEnter: { type: "boolean", default: false },
        after: afterActionSchema
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
        ...deviceProperties,
        ...displayTargetProperties,
        action: { type: "string", minLength: 1 },
        selector: selectorSchema,
        text: { type: "string", minLength: 1, description: "Text used by the set_text action." },
        after: afterActionSchema
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
        ...deviceProperties,
        ...displayTargetProperties,
        x: integerSchema,
        y: integerSchema,
        durationMs: { ...integerSchema, default: 650 },
        after: afterActionSchema
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
      properties: { ...deviceProperties, ...displayTargetProperties, key: { type: "string", enum: Object.keys(KEYCODES) }, after: afterActionSchema },
      additionalProperties: false
    },
    handler: androidKey
  },
  {
    name: "android_go_home",
    description: "Send the HOME key event through the persistent on-device UIAutomator bridge.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties, after: afterActionSchema }, additionalProperties: false },
    handler: androidGoHome
  },
  {
    name: "android_open_notifications",
    description: "Open the notification shade on display 0.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties, after: afterActionSchema }, additionalProperties: false },
    handler: androidOpenNotifications
  },
  {
    name: "android_open_quick_settings",
    description: "Open Quick Settings on display 0.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties, after: afterActionSchema }, additionalProperties: false },
    handler: androidOpenQuickSettings
  },
  {
    name: "android_close_keyboard",
    description: "Request that the software keyboard close without navigating Back.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties, after: afterActionSchema }, additionalProperties: false },
    handler: androidCloseKeyboard
  },
  {
    name: "android_grant_permission_dialog",
    description: "Grant the visible Android runtime-permission dialog using a preferred allow choice.",
    inputSchema: {
      type: "object",
      properties: { ...deviceProperties, ...displayTargetProperties, choice: { type: "string", enum: ["while_using", "once", "allow"], default: "while_using" }, ...stableSnapshotProperties },
      additionalProperties: false
    },
    handler: androidGrantPermissionDialog
  },
  {
    name: "android_open_recents",
    description: "Open Android's recent-apps overview.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties, after: afterActionSchema }, additionalProperties: false },
    handler: androidOpenRecents
  },
  {
    name: "android_switch_recent_app",
    description: "Switch to the previously used app by issuing the recents quick-switch gesture.",
    inputSchema: { type: "object", properties: { ...deviceProperties, ...displayTargetProperties, after: afterActionSchema }, additionalProperties: false },
    handler: androidSwitchRecentApp
  },
  {
    name: "android_list_apps",
    description: "List launcher apps with application IDs, launch activities, and best-effort localized app labels.",
    inputSchema: {
      type: "object",
      properties: {
        ...deviceProperties,
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
        ...deviceProperties,
        ...displayTargetProperties,
        applicationId: { type: "string", minLength: 1 },
        appName: { type: "string", minLength: 1 },
        allowSubstring: { type: "boolean", default: true },
        resolveLabels: { type: "boolean", default: true },
        after: afterActionSchema
      },
      additionalProperties: false
    },
    handler: androidLaunchApp
  }
];

const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
const actionToolNames = new Set([
  "android_tap", "android_tap_ref", "android_fill_ref", "android_long_press_ref", "android_perform_action_ref",
  "android_tap_text", "android_tap_content_desc", "android_click", "android_fill_near_label", "android_swipe",
  "android_input_text", "android_perform_action", "android_long_press", "android_key", "android_go_home", "android_launch_app",
  "android_open_notifications", "android_open_quick_settings", "android_close_keyboard", "android_grant_permission_dialog",
  "android_open_recents", "android_switch_recent_app"
]);

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
    const listParams = optionalObject(request.params);
    const requested = Array.isArray(listParams.capabilities)
      ? new Set(listParams.capabilities.filter((value): value is CapabilityGroup => typeof value === "string" && ALL_CAPABILITY_GROUPS.includes(value as CapabilityGroup)))
      : undefined;
    const visibleTools = tools.filter((tool) => {
      if (tool.name === "android_capabilities") return true;
      const group = capabilityGroupForTool(tool.name);
      return enabledCapabilityGroups.has(group) && (!requested || requested.has(group));
    });
    sendResponse(id, {
      tools: visibleTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, _meta: { "android-ui-mcp/capabilityGroup": capabilityGroupForTool(name) } }))
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
  const group = capabilityGroupForTool(name);
  if (name !== "android_capabilities" && !enabledCapabilityGroups.has(group)) {
    sendError(id, -32602, `Tool '${name}' is disabled because capability group '${group}' is not enabled.`);
    return;
  }

  const started = performance.now();
  try {
    let result = await tool.handler(call.arguments);
    if (actionToolNames.has(name) && result.success !== false) {
      const after = await runAfterConditions(call.arguments);
      if (after) result = { ...result, success: after.success === true, after };
    }
    await recordTraceEvent(name, call.arguments, result, undefined, Math.round(performance.now() - started)).catch((traceError) => {
      process.stderr.write(`[android-ui-mcp] Trace write failed: ${(traceError as Error).message}\n`);
    });
    sendResponse(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    });
  } catch (error) {
    const err = error as Error;
    await recordTraceEvent(name, call.arguments, undefined, err, Math.round(performance.now() - started)).catch(() => undefined);
    const data =
      error instanceof AdbCommandError || error instanceof AndroidBridgeError || error instanceof AndroidDeviceError ? error.details : undefined;
    sendResponse(id, {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: err.message, data }, null, 2) }]
    });
  }
}

let buffer = "";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
}

async function parseAndHandle(line: string): Promise<void> {
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    await handleRequest(request);
  } catch (error) {
    const err = error as Error;
    sendError(null, -32700, err.message);
  }
}

export const __test = {
  displayTargetParams,
  bridgeDisplayTarget,
  createSemanticSnapshot,
  invalidateVirtualSessions,
  activeVirtualSessions,
  staleVirtualSessions,
  snapshotCache,
  bridgeRpcOnPort,
  bridgeRpcOnSocket,
  rankSemanticNodes,
  mergeSemanticNodes,
  compactNodes,
  renderUiOutline,
  toolDefinition: (name: string) => toolMap.get(name),
  relocateAccessibilityNode,
  afterConditions,
  capabilityGroupForTool,
  sanitizeTraceValue,
  ocrCache,
  androidTraceStart,
  androidTraceStatus,
  androidTraceStop,
  recordTraceEvent
};
