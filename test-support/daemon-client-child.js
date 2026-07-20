import { StoreClient } from "../src/store/store-client.js";

const [socketPath, project, nonce] = process.argv.slice(2);
const client = new StoreClient({
  socketPath,
  project,
  client: `child-${process.pid}`,
  clientVersion: "1.0.0",
});

try {
  const reply = await client.ping(nonce);
  process.send?.({ ok: true, reply });
} catch (error) {
  process.send?.({
    ok: false,
    error: { code: error?.code, message: error instanceof Error ? error.message : String(error) },
  });
  process.exitCode = 1;
} finally {
  client.close();
}
