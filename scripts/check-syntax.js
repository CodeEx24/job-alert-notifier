// Parses every script the extension ships (node --check), so a syntax error
// in a file the linter does not cover yet still fails CI. Dev tooling only.
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import console from "node:console";
import process from "node:process";

const SHIPPED = readdirSync(".").filter((name) => name.endsWith(".js") && !name.endsWith(".config.js"));

let failed = 0;
for (const file of SHIPPED) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failed += 1;
    process.stderr.write(`${file}\n${err.stderr}\n`);
  }
}
console.log(`check-syntax: ${SHIPPED.length - failed}/${SHIPPED.length} files parse`);
process.exit(failed ? 1 : 0);
