import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function functionBody(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = app.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    if (app[i] === "}") depth -= 1;
    if (depth === 0) return app.slice(bodyStart + 1, i);
  }
  throw new Error(`${name} body was not closed`);
}

const dashboard = functionBody("renderDashboard");
const data = functionBody("renderData");

assert.equal(
  dashboard.includes("renderNodeCardMPPT()"),
  false,
  "dashboard output page must not render MPPT monitoring"
);
assert.equal(
  data.includes("renderNodeCardMPPT()"),
  true,
  "second data page must render MPPT monitoring"
);
assert.match(
  app,
  /selectedNode:\s*"channel_a"/,
  "output page charts should default to an output channel, not MPPT"
);

console.log("layout tests passed");
