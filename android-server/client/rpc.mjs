import net from "node:net";
import { performance } from "node:perf_hooks";

const method = process.argv[2] || "ping";
const params = Object.fromEntries(
  process.argv.slice(3).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=")];
  })
);

const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.env.ANDROID_UI_MCP_PORT || 27183) });
let buffer = "";
const start = performance.now();

socket.on("connect", () => {
  socket.write(`${JSON.stringify({ method, ...params })}\n`);
});

socket.on("data", (data) => {
  buffer += String(data);
  const newline = buffer.indexOf("\n");
  if (newline === -1) return;
  const line = buffer.slice(0, newline);
  const response = JSON.parse(line);
  response.hostElapsedMs = Math.round(performance.now() - start);
  console.log(JSON.stringify(response, null, 2));
  socket.end();
});

socket.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
