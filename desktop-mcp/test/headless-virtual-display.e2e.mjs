import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import readline from "node:readline";

const deviceId = process.env.ANDROID_SERIAL;
if (!deviceId) throw new Error("Set ANDROID_SERIAL to an Android 14+ device serial.");

// Start from a deterministic task state; the target app otherwise restores its last search activity.
execFileSync("adb", ["-s", deviceId, "shell", "am", "force-stop", "com.android.settings"]);
execFileSync("adb", ["-s", deviceId, "shell", "am", "force-stop", "com.google.android.settings.intelligence"]);
execFileSync("adb", ["-s", deviceId, "shell", "pm", "clear", "com.android.camera2"]);

const server = spawn(process.execPath, ["src/server.ts"], { cwd: new URL("..", import.meta.url), stdio: ["pipe", "pipe", "inherit"] });
const lines = readline.createInterface({ input: server.stdout });
const pending = new Map();
let nextId = 1;

lines.on("line", (line) => {
  const response = JSON.parse(line);
  const entry = pending.get(response.id);
  if (entry) {
    pending.delete(response.id);
    entry.resolve(response);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool(name, arguments_, expectError = false) {
  const response = await request("tools/call", { name, arguments: { deviceId, ...arguments_ } });
  assert.equal(Boolean(response.result?.isError), expectError, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
}

let sessionId;
try {
  await request("initialize");
  const traceTools = await request("tools/list", { capabilities: ["trace"] });
  assert.ok(traceTools.result.tools.some((item) => item.name === "android_trace_start"));
  assert.ok(traceTools.result.tools.every((item) => item.name === "android_capabilities" || item._meta["android-ui-mcp/capabilityGroup"] === "trace"));
  const coreTools = await request("tools/list", { capabilities: ["core"] });
  assert.ok(coreTools.result.tools.some((item) => item.name === "android_get_ui_outline"));
  const trace = await tool("android_trace_start", { traceId: `e2e-${Date.now()}` });
  const physical = await tool("android_screenshot", {});
  assert.equal(physical.displayId, 0);
  assert.ok(physical.width > 0 && physical.height > 0);
  await tool("android_current_app", {});

  const created = await tool("android_create_virtual_display", {
    width: 1024,
    height: 768,
    dpi: 240,
    displayImePolicy: 0
  });
  sessionId = created.sessionId;
  assert.equal(created.success, true);
  assert.equal(created.displayImePolicyApplied, true);
  const displays = await tool("android_list_displays", {});
  assert.ok(displays.displays.some((display) => display.sessionId === sessionId && display.mcpOwned === true));

  const launched = await tool("android_launch_app", {
    sessionId,
    applicationId: "com.android.settings",
    after: { waitForPackage: "com.android.settings", timeoutMs: 5000, pollIntervalMs: 200 }
  });
  assert.equal(launched.displayId, created.displayId);
  assert.equal(launched.after.success, true);
  const physicalAfterVirtualLaunch = await tool("android_current_app", {});
  assert.equal(typeof physicalAfterVirtualLaunch.packageName, "string");
  const wait = await tool("android_wait_for_package", { sessionId, packageName: "com.android.settings", timeoutMs: 5000 });
  assert.equal(wait.success, true);

  const screenshot = await tool("android_screenshot", { sessionId, timeoutMs: 5000 });
  assert.deepEqual([screenshot.width, screenshot.height], [1024, 768]);
  const ocr = await tool("android_ocr_screen", { sessionId, ocrEngine: "apple-vision", maxNodes: 10 });
  assert.equal(ocr.sessionId, sessionId);
  assert.deepEqual([ocr.width, ocr.height], [1024, 768]);
  assert.equal(ocr.ocrCached, false);
  const cachedOcr = await tool("android_ocr_screen", { sessionId, ocrEngine: "apple-vision", maxNodes: 10 });
  assert.equal(cachedOcr.ocrCached, true);

  const semantic = await tool("android_get_semantic_screen", {
    sessionId,
    ocrMode: "off",
    visionMode: "off",
    includeScreenshot: false,
    maxNodes: 80
  });
  assert.equal(semantic.sessionId, sessionId);
  assert.ok(semantic.accessibilityNodeCount > 0);
  const outline = await tool("android_get_ui_outline", {
    sessionId,
    ocrMode: "off",
    visionMode: "off"
  });
  assert.equal(outline.screenSignature, semantic.screenSignature);
  assert.equal(Object.hasOwn(outline, "imagePath"), false);
  assert.equal(Object.hasOwn(outline, "entries"), false);
  assert.ok(JSON.stringify(outline).length <= JSON.stringify(semantic).length * 0.5);
  const outlineRefs = new Set(outline.outline.split("\n").map((line) => line.trim().split(" ")[0]));
  const actionableRefs = semantic.nodes
    .filter((node) => node.source === "accessibility" && (node.clickable || node.scrollable || node.editable || node.actions?.length))
    .map((node) => node.ref);
  assert.deepEqual(actionableRefs.filter((ref) => !outlineRefs.has(ref)), []);
  const search = semantic.nodes.find((node) => node.resourceId === "com.android.settings:id/search_action_bar");
  assert.ok(search?.ref);

  const viewer = await tool("android_viewer_start", { sessionId, port: 0, allowActions: true, ocrMode: "off", visionMode: "off" });
  const viewerUrl = new URL(viewer.url);
  const viewerToken = new URLSearchParams(viewerUrl.hash.slice(1)).get("token");
  const viewerHeaders = { Authorization: `Bearer ${viewerToken}` };
  assert.equal((await fetch(`${viewerUrl.origin}/api/status`)).status, 401);
  const viewerSnapshot = await (await fetch(`${viewerUrl.origin}/api/refresh`, { method: "POST", headers: viewerHeaders })).json();
  assert.equal(viewerSnapshot.sessionId, sessionId);
  assert.ok(viewerSnapshot.entries.some((entry) => entry.ref === search.ref));
  const viewerTap = await (await fetch(`${viewerUrl.origin}/api/tap`, {
    method: "POST",
    headers: { ...viewerHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ snapshotId: viewerSnapshot.snapshotId, ref: search.ref })
  })).json();
  assert.equal(viewerTap.success, true);
  assert.ok(["fresh", "relocated"].includes(viewerTap.action.status));
  const viewerStatus = await tool("android_viewer_status", {});
  assert.equal(viewerStatus.snapshotId, viewerTap.snapshot.snapshotId);
  assert.equal((await tool("android_viewer_stop", {})).status, "viewer_stopped");
  const refGone = await tool("android_wait_for_ref_gone", {
    sessionId,
    snapshotId: semantic.snapshotId,
    ref: search.ref,
    timeoutMs: 5000,
    pollIntervalMs: 200
  });
  assert.equal(refGone.success, true);
  const searchReady = await tool("android_wait_for_text", {
    sessionId,
    text: "Search settings",
    role: "textbox",
    timeoutMs: 5000,
    pollIntervalMs: 200
  });
  assert.equal(searchReady.success, true);
  const textbox = searchReady.currentSnapshot.nodes.find((node) => node.editable === true);
  assert.ok(textbox?.ref);
  const filled = await tool("android_fill_ref", {
    sessionId,
    snapshotId: searchReady.currentSnapshot.snapshotId,
    ref: textbox.ref,
    text: "battery",
    stableTimeoutMs: 2500,
    after: { waitForText: "battery", role: "textbox", timeoutMs: 5000, pollIntervalMs: 200 }
  });
  assert.equal(filled.success, true);
  assert.equal(filled.after.success, true);
  await tool("android_key", { sessionId, key: "BACK" });
  await tool("android_swipe", { sessionId, x1: 512, y1: 650, x2: 512, y2: 250, durationMs: 300 });

  const mismatch = await tool("android_tap_ref", {
    displayId: 0,
    snapshotId: semantic.snapshotId,
    ref: search.ref,
    returnSnapshot: false
  });
  assert.equal(mismatch.status, "ref_not_found");

  const replaced = await tool("android_create_virtual_display", { width: 800, height: 600, dpi: 160 });
  const recreatedError = await tool("android_screenshot", { sessionId }, true);
  assert.equal(recreatedError.data.status, "virtual_display_recreated");
  sessionId = replaced.sessionId;

  await tool("android_bridge_exit", {});
  const restartError = await tool("android_screenshot", { sessionId }, true);
  assert.equal(restartError.data.status, "bridge_restarted");
  sessionId = undefined;

  await tool("android_launch_app", { applicationId: "com.android.settings" });
  const defaultWait = await tool("android_wait_for_package", { packageName: "com.android.settings", timeoutMs: 5000 });
  assert.equal(defaultWait.success, true);
  const defaultSemantic = await tool("android_get_semantic_screen", {
    ocrMode: "off",
    visionMode: "off",
    includeScreenshot: false,
    maxNodes: 80
  });
  assert.equal(defaultSemantic.displayId, 0);
  assert.ok(defaultSemantic.accessibilityNodeCount > 0);
  const defaultSearch = defaultSemantic.nodes.find((node) => node.resourceId === "com.android.settings:id/search_action_bar");
  assert.ok(defaultSearch?.ref);
  const defaultTapped = await tool("android_tap_ref", {
    snapshotId: defaultSemantic.snapshotId,
    ref: defaultSearch.ref,
    stableTimeoutMs: 2500
  });
  assert.equal(defaultTapped.success, true);
  const defaultSearchReady = await tool("android_wait_for_text", {
    text: "Search settings",
    role: "textbox",
    timeoutMs: 5000,
    pollIntervalMs: 200
  });
  assert.equal(defaultSearchReady.success, true);
  const defaultTextbox = defaultSearchReady.currentSnapshot.nodes.find((node) => node.editable === true);
  assert.ok(defaultTextbox?.ref);
  const defaultFilled = await tool("android_fill_ref", {
    snapshotId: defaultSearchReady.currentSnapshot.snapshotId,
    ref: defaultTextbox.ref,
    text: "battery",
    stableTimeoutMs: 2500
  });
  assert.equal(defaultFilled.success, true);
  const keyboard = await tool("android_close_keyboard", {});
  assert.equal(keyboard.success, true);
  await tool("android_key", { key: "BACK" });

  assert.equal((await tool("android_open_notifications", {})).success, true);
  assert.equal((await tool("android_open_quick_settings", {})).success, true);
  assert.equal((await tool("android_open_recents", {})).success, true);
  assert.equal((await tool("android_switch_recent_app", {})).success, true);
  const noPermissionDialog = await tool("android_grant_permission_dialog", { choice: "allow", waitForStable: false });
  assert.equal(noPermissionDialog.status, "permission_dialog_not_found");

  await tool("android_go_home", {});
  await tool("android_launch_app", { applicationId: "com.android.camera2" });
  const cameraOnboarding = await tool("android_wait_for_text", { text: "NEXT", timeoutMs: 5000, pollIntervalMs: 200 });
  assert.equal(cameraOnboarding.success, true);
  const nextButton = cameraOnboarding.currentSnapshot.nodes.find((node) => node.text === "NEXT");
  assert.ok(nextButton?.ref);
  await tool("android_tap_ref", { snapshotId: cameraOnboarding.currentSnapshot.snapshotId, ref: nextButton.ref, waitForStable: false });
  const permissionReady = await tool("android_wait_for_text", { text: "While using the app", timeoutMs: 5000, pollIntervalMs: 200 });
  assert.equal(permissionReady.success, true);
  const granted = await tool("android_grant_permission_dialog", { choice: "while_using", waitForStable: true });
  assert.equal(granted.success, true);
  const cameraReady = await tool("android_wait_for_package", { packageName: "com.android.camera2", timeoutMs: 5000, pollIntervalMs: 200 });
  assert.equal(cameraReady.success, true);
  const cameraSemantic = await tool("android_get_semantic_screen", {
    ocrMode: "auto",
    visionMode: "auto",
    includeScreenshot: false,
    maxNodes: 30
  });
  assert.equal(cameraSemantic.packageName, "com.android.camera2");
  assert.equal(cameraSemantic.ocrUsed, true);
  assert.equal(cameraSemantic.visionUsed, true);

  const destroyTarget = await tool("android_create_virtual_display", { width: 800, height: 600, dpi: 160 });
  await tool("android_destroy_virtual_display", { sessionId: destroyTarget.sessionId });
  const destroyedError = await tool("android_screenshot", { sessionId: destroyTarget.sessionId }, true);
  assert.equal(destroyedError.data.status, "virtual_display_not_found");

  const stoppedTrace = await tool("android_trace_stop", {});
  assert.equal(stoppedTrace.status, "trace_stopped");
  assert.ok(stoppedTrace.stepCount > 10);
  const traceEvents = await readFile(`${trace.directory}/events.jsonl`, "utf8");
  assert.match(traceEvents, /android_screenshot/);

  process.stdout.write("headless virtual display e2e: PASS\n");
} finally {
  await tool("android_viewer_stop", {}).catch(() => undefined);
  if (sessionId) {
    await tool("android_destroy_virtual_display", { sessionId }).catch(() => undefined);
  }
  server.kill();
}
