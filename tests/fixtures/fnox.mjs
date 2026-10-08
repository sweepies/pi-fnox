#!/usr/bin/env node
// Deterministic CLI fixture: never reads a vault or accesses the network.
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.FNOX_TEST_LOG) appendFileSync(process.env.FNOX_TEST_LOG, `${JSON.stringify(args)}\n`);
if (args.includes("--no-daemon") || !args.includes("--config") || !args.includes("json")) process.exit(9);
const profile = args[args.indexOf("--profile") + 1];
if (profile === "fail") {
  console.error("fixture-secret-token: private provider error");
  process.exit(42);
}
if (profile === "overflow") console.log("fixture-secret-token".repeat(250_000));
else console.log(JSON.stringify({ secrets: { FNOX_TEST_TOKEN: "fixture-secret-token" } }));
