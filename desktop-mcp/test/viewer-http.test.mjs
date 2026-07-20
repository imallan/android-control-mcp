import test from "node:test";
import assert from "node:assert/strict";
import { startViewerHttpServer, viewerRequestAuthorized } from "../src/viewer.ts";

test("Viewer bearer authorization is exact", () => {
  assert.equal(viewerRequestAuthorized("Bearer secret", "secret"), true);
  assert.equal(viewerRequestAuthorized("Bearer secret-extra", "secret"), false);
  assert.equal(viewerRequestAuthorized(undefined, "secret"), false);
});

test("Viewer HTTP server protects APIs and rejects non-accessibility taps", async () => {
  let tapped;
  const viewer = await startViewerHttpServer({
    port: 0,
    callbacks: {
      status: () => ({ status: "viewer_running" }),
      refresh: async () => ({ snapshotId: "screen:test", outline: "[Content]" }),
      frame: async (snapshotId) => snapshotId === "screen:test" ? Buffer.from([137, 80, 78, 71]) : undefined,
      tap: async (snapshotId, ref) => {
        tapped = { snapshotId, ref };
        return { success: true };
      }
    }
  });
  const base = `http://127.0.0.1:${viewer.port}`;
  const headers = { Authorization: `Bearer ${viewer.token}` };
  try {
    assert.match(viewer.url, new RegExp(`^${base.replaceAll(".", "\\.")}/#token=`));
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.match(await page.text(), /Android MCP Viewer/);

    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.deepEqual(await (await fetch(`${base}/api/status`, { headers })).json(), { status: "viewer_running" });
    assert.equal((await fetch(`${base}/api/refresh`, { method: "POST", headers })).status, 200);
    assert.equal((await fetch(`${base}/api/frame?snapshotId=missing`, { headers })).status, 404);

    const rejected = await fetch(`${base}/api/tap`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId: "screen:test", ref: "o1" })
    });
    assert.equal(rejected.status, 400);
    assert.equal(tapped, undefined);

    const accepted = await fetch(`${base}/api/tap`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId: "screen:test", ref: "a1" })
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(tapped, { snapshotId: "screen:test", ref: "a1" });
  } finally {
    await viewer.close();
  }
});
