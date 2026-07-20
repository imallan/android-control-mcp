import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type ViewerCallbacks = {
  status: () => Record<string, unknown>;
  refresh: () => Promise<Record<string, unknown>>;
  frame: (snapshotId: string) => Promise<Buffer | undefined>;
  tap: (snapshotId: string, ref: string) => Promise<Record<string, unknown>>;
};

export type ViewerHttpServer = {
  server: Server;
  token: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

const STATIC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer");
const MAX_BODY_BYTES = 64 * 1024;

export async function startViewerHttpServer(options: {
  port: number;
  callbacks: ViewerCallbacks;
  staticRoot?: string;
}): Promise<ViewerHttpServer> {
  const token = randomBytes(32).toString("base64url");
  const staticRoot = options.staticRoot ?? STATIC_ROOT;
  const server = createServer((request, response) => {
    void handleViewerRequest(request, response, token, options.callbacks, staticRoot);
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Viewer HTTP server did not receive a TCP address.");
  }
  const url = `http://127.0.0.1:${address.port}/#token=${token}`;
  return {
    server,
    token,
    port: address.port,
    url,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

export function viewerRequestAuthorized(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function handleViewerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  callbacks: ViewerCallbacks,
  staticRoot: string
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && ["/", "/app.js", "/styles.css"].includes(url.pathname)) {
      const fileName = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const contentType = fileName.endsWith(".html") ? "text/html; charset=utf-8" : fileName.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
      sendStatic(response, await readFile(join(staticRoot, fileName)), contentType);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!viewerRequestAuthorized(request.headers.authorization, token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      sendJson(response, 200, callbacks.status());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      sendJson(response, 200, await callbacks.refresh());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/frame") {
      const snapshotId = url.searchParams.get("snapshotId") ?? "";
      const frame = snapshotId ? await callbacks.frame(snapshotId) : undefined;
      if (!frame) {
        sendJson(response, 404, { error: "frame_not_found" });
        return;
      }
      sendBuffer(response, 200, frame, "image/png");
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/tap") {
      const body = await readJsonBody(request);
      const snapshotId = typeof body.snapshotId === "string" ? body.snapshotId : "";
      const ref = typeof body.ref === "string" ? body.ref : "";
      if (!snapshotId || !/^a\d+$/.test(ref)) {
        sendJson(response, 400, { error: "invalid_ref", message: "Tap requires snapshotId and an accessibility aN ref." });
        return;
      }
      sendJson(response, 200, await callbacks.tap(snapshotId, ref));
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  } catch (error) {
    sendJson(response, 500, { error: "viewer_error", message: (error as Error).message });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object body.");
  return parsed as Record<string, unknown>;
}

function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
  };
}

function sendStatic(response: ServerResponse, body: Buffer, contentType: string): void {
  response.writeHead(200, { ...securityHeaders(contentType), "Content-Length": body.length });
  response.end(body);
}

function sendBuffer(response: ServerResponse, status: number, body: Buffer, contentType: string): void {
  response.writeHead(status, { ...securityHeaders(contentType), "Content-Length": body.length });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  sendBuffer(response, status, body, "application/json; charset=utf-8");
}
