// One synchronous, bounded request from the unprivileged historical engine to
// the controller. This process has no access to the controller's SQLite files.
import net from "node:net";

if (process.getuid?.() !== 65534 || process.argv.length !== 2)
  throw new Error("Retry RPC helper requires the dedicated candidate user");
const socketPath = process.env.GRAPH_RETRY_CONTROL_SOCKET;
if (
  typeof socketPath !== "string" ||
  !/^\/tmp\/graph-retry-control-[A-Za-z0-9_-]+\/control\.sock$/.test(socketPath)
)
  throw new Error("Invalid retry controller socket");
let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  if (input.length > 65_536) throw new Error("Retry RPC input limit");
}
if (!input.length || input.includes(10))
  throw new Error("Invalid retry RPC frame");
const socket = net.createConnection(socketPath);
socket.setTimeout(8_000, () => socket.destroy(new Error("Retry RPC timeout")));
let output = Buffer.alloc(0);
socket.on("connect", () =>
  socket.write(Buffer.concat([input, Buffer.from("\n")])),
);
for await (const chunk of socket) {
  output = Buffer.concat([output, chunk]);
  if (output.length > 65_536) throw new Error("Retry RPC output limit");
}
if (
  output.length < 2 ||
  output.at(-1) !== 10 ||
  output.subarray(0, -1).includes(10)
)
  throw new Error("Invalid retry controller response");
process.stdout.write(output.subarray(0, -1));
