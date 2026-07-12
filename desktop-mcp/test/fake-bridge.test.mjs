import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __test } from "../src/server.ts";

async function withFakeBridge(response, run) {
  const socketPath = join(tmpdir(), `android-ui-mcp-fake-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (data) => {
      const request = JSON.parse(data.trim());
      socket.write(`${JSON.stringify(typeof response === "function" ? response(request) : response)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await run(socketPath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("fake bridge round-trips method and params", async () => {
  await withFakeBridge((request) => ({ ok: true, echoed: request }), async (socketPath) => {
    const result = await __test.bridgeRpcOnSocket("fake-device", socketPath, "tap", { x: 12, y: 34 }, 1000);
    assert.deepEqual(result.echoed, { method: "tap", x: 12, y: 34 });
    assert.equal(typeof result.hostElapsedMs, "number");
  });
});

test("fake bridge normalizes bridge-side errors", async () => {
  await withFakeBridge({ ok: false, error: "bad selector" }, async (socketPath) => {
    await assert.rejects(
      __test.bridgeRpcOnSocket("fake-device", socketPath, "performAction", {}, 1000),
      (error) => error.name === "AndroidBridgeError" && error.details.response.error === "bad selector"
    );
  });
});
