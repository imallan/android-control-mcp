import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test } from "../src/server.ts";

const temporaryDirectories = [];

afterEach(async () => {
  __test.resetVideoRuntime();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryOutput(name = "recording.mp4") {
  const directory = await mkdtemp(join(tmpdir(), "android-ui-mcp-video-test-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

function installFakeVideoRuntime(options = {}) {
  let running = false;
  let remotePath = "";
  let nowMs = 1_000;
  let cleanupSucceeds = options.cleanupSucceeds ?? true;
  const calls = [];

  __test.setVideoRuntime({
    resolveDeviceId: async (input) => typeof input.deviceId === "string" ? input.deviceId : "fake-device",
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    adbText: async (args) => {
      calls.push(args);
      if (args[0] === "pull") {
        await writeFile(args[2], Buffer.from("fake-mp4-data"));
        return `${args[0]}: 1 file pulled\n`;
      }
      const command = args[1] ?? "";
      if (command.includes("screenrecord ")) {
        remotePath = command.match(/(\/data\/local\/tmp\/android-ui-mcp\/recordings\/recording-[\w-]+\.mp4)/)?.[1] ?? "";
        running = true;
        return "4242\n";
      }
      if (command.startsWith("cat /proc/4242/cmdline")) {
        return running ? ["screenrecord", "--time-limit", "180", remotePath].join("\0") : "";
      }
      if (command.includes("kill -INT 4242")) {
        running = false;
        return "signaled\n";
      }
      if (command.startsWith("rm -f ")) {
        return cleanupSucceeds ? "cleaned\n" : "cleanup_failed\n";
      }
      if (command.includes(".log")) return "";
      return "";
    }
  });

  return {
    calls,
    finishNaturally: () => {
      running = false;
    },
    allowCleanup: () => {
      cleanupSucceeds = true;
    }
  };
}

test("video recording tools are media-scoped with strict display-0 schemas", () => {
  for (const name of ["android_record_video_start", "android_record_video_status", "android_record_video_stop"]) {
    const tool = __test.toolDefinition(name);
    assert.equal(__test.capabilityGroupForTool(name), "media");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.properties.displayId.enum, [0]);
  }
  const start = __test.toolDefinition("android_record_video_start");
  assert.equal(start.inputSchema.properties.timeLimitSec.default, 180);
  assert.equal(start.inputSchema.properties.timeLimitSec.maximum, 180);
  assert.equal(start.inputSchema.properties.overwrite.default, false);
});

test("video recording input validation rejects unsupported targets and invalid encoder options", () => {
  assert.throws(() => __test.validateRecordVideoDisplayTarget({ sessionId: "virtual" }), /sessionId is not supported/);
  assert.throws(() => __test.validateRecordVideoDisplayTarget({ displayId: 1 }), /displayId 0 only/);
  assert.throws(() => __test.recordVideoStartOptions({ size: "1280*720" }), /WIDTHxHEIGHT/);
  assert.throws(() => __test.recordVideoStartOptions({ bitRate: 0 }), /positive integer/);
  assert.throws(() => __test.recordVideoStartOptions({ timeLimitSec: 181 }), /1 through 180/);
  assert.equal(__test.recordVideoStartOptions({ displayId: 0 }).timeLimitSec, 180);
});

test("start, status, and stop verify the PID, send SIGINT, pull, and clean up", async () => {
  const fake = installFakeVideoRuntime();
  const outputPath = await temporaryOutput();
  const started = await __test.androidRecordVideoStart({ outputPath, size: "1280x720", bitRate: 6_000_000, timeLimitSec: 30 });
  assert.equal(started.status, "recording_started");
  assert.equal(started.pid, 4242);
  assert.equal(started.audio, false);
  assert.match(started.rotationWarning, /rotation/);

  const status = await __test.androidRecordVideoStatus({});
  assert.equal(status.status, "recording");
  const stopped = await __test.androidRecordVideoStop({ displayId: 0 });
  assert.equal(stopped.status, "recording_stopped");
  assert.equal(stopped.fileSizeBytes, 13);
  assert.equal(await readFile(outputPath, "utf8"), "fake-mp4-data");
  assert.ok(fake.calls.some((args) => (args[1] ?? "").includes("kill -INT 4242")));
  assert.ok(fake.calls.some((args) => args[0] === "pull"));
  assert.ok(fake.calls.some((args) => (args[1] ?? "").startsWith("rm -f ")));
  assert.equal((await __test.androidRecordVideoStatus({})).status, "recording_not_active");
});

test("natural completion waits for stop to pull and does not signal a reused PID", async () => {
  const fake = installFakeVideoRuntime();
  const outputPath = await temporaryOutput();
  await __test.androidRecordVideoStart({ outputPath });
  fake.finishNaturally();
  assert.equal((await __test.androidRecordVideoStatus({})).status, "completed_pending_pull");
  assert.equal((await __test.androidRecordVideoStop({})).status, "recording_stopped");
  assert.ok(!fake.calls.some((args) => (args[1] ?? "").includes("kill -INT 4242")));
});

test("existing outputs require overwrite and concurrent starts reserve one device", async () => {
  installFakeVideoRuntime();
  const outputPath = await temporaryOutput();
  await writeFile(outputPath, "existing");
  await assert.rejects(__test.androidRecordVideoStart({ outputPath }), /overwrite: true/);

  const firstPath = await temporaryOutput("first.mp4");
  const secondPath = await temporaryOutput("second.mp4");
  const results = await Promise.allSettled([
    __test.androidRecordVideoStart({ outputPath: firstPath }),
    __test.androidRecordVideoStart({ outputPath: secondPath })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /already has a managed video recording/);
});

test("concurrent starts on different devices cannot reserve the same output path", async () => {
  installFakeVideoRuntime();
  const outputPath = await temporaryOutput();
  const results = await Promise.allSettled([
    __test.androidRecordVideoStart({ deviceId: "device-a", outputPath }),
    __test.androidRecordVideoStart({ deviceId: "device-b", outputPath })
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /already reserved/);
});

test("cleanup failure remains retryable without pulling the video twice", async () => {
  const fake = installFakeVideoRuntime({ cleanupSucceeds: false });
  const outputPath = await temporaryOutput();
  await __test.androidRecordVideoStart({ outputPath });
  await assert.rejects(__test.androidRecordVideoStop({}), /cleanup did not complete/);
  assert.equal((await __test.androidRecordVideoStatus({})).status, "cleanup_pending");
  assert.equal(fake.calls.filter((args) => args[0] === "pull").length, 1);

  fake.allowCleanup();
  assert.equal((await __test.androidRecordVideoStop({})).status, "recording_stopped");
  assert.equal(fake.calls.filter((args) => args[0] === "pull").length, 1);
});
