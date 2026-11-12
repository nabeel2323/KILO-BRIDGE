"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { findProhibitedFiles } from "../src/components/publishing";
import { makeWorkerEnv, baseGhFixtures } from "./helpers/worker-env";

test("publishing: prohibited file detection", () => {
  const prohibited = findProhibitedFiles([
    "src/index.ts",
    ".env",
    ".env.production",
    "config/secrets/api.json",
    "certs/server.pem",
    "keys/private.key",
    "id_rsa",
    "bridge.config.json",
    "data/kilo-bridge.sqlite",
    "README.md",
  ]);
  assert.ok(prohibited.includes(".env"));
  assert.ok(prohibited.includes(".env.production"));
  assert.ok(prohibited.includes("config/secrets/api.json"));
  assert.ok(prohibited.includes("certs/server.pem"));
  assert.ok(prohibited.includes("keys/private.key"));
  assert.ok(prohibited.includes("id_rsa"));
  assert.ok(prohibited.includes("bridge.config.json"));
  assert.ok(prohibited.includes("data/kilo-bridge.sqlite"));
  assert.ok(!prohibited.includes("src/index.ts"));
  assert.ok(!prohibited.includes("README.md"));
  // Windows-style separators are normalized.
  assert.ok(findProhibitedFiles(["config\\secrets\\x.json"]).length === 1);
});

test("publishing: refuses when required verification did not pass", async () => {
  const env = await makeWorkerEnv({
    publishingEnabled: true,
    verificationCommands: ['node -e "process.exit(1)"'],
  });
  await env.worker.pollOnce();
  const fixtures = baseGhFixtures();
  fixtures.api["repos/test-owner/test-repo/issues/1"].labels = [{ name: "kilo:report-ready" }, { name: "kilo:publish-approved" }];
  env.setGhFixtures(fixtures);
  const res = await env.worker.pollOnce();
  assert.equal(res.data![0].published, 0);
  const task = env.store.listTasksByProject("test-project")[0];
  assert.equal(task.status, "REPORT_READY", "must not publish on failed verification");
  // Refusal is communicated on the issue.
  const refusal = env.ghCalls().find((c) => c.argv.includes("POST") && c.argv.some((a: string) => a.includes("/comments")) && c.stdin && JSON.parse(c.stdin).body.includes("Publishing refused"));
  assert.ok(refusal, "refusal comment posted");
  env.cleanup();
});

test("publishing: refuses without the approval label", async () => {
  const env = await makeWorkerEnv({ publishingEnabled: true });
  await env.worker.pollOnce();
  // Issue has report-ready but NO publish-approved.
  const res = await env.worker.pollOnce();
  assert.equal(res.data![0].published, 0);
  const task = env.store.listTasksByProject("test-project")[0];
  assert.equal(task.status, "REPORT_READY");
  env.cleanup();
});

test("publishing: prohibited file in the change set blocks publishing", async () => {
  const env = await makeWorkerEnv({
    publishingEnabled: true,
    kiloFixtures: { run: { createFile: { name: ".env", content: "SECRET=x" }, finalText: "done" } },
  });
  await env.worker.pollOnce();
  const fixtures = baseGhFixtures();
  fixtures.api["repos/test-owner/test-repo/issues/1"].labels = [{ name: "kilo:report-ready" }, { name: "kilo:publish-approved" }];
  env.setGhFixtures(fixtures);
  const res = await env.worker.pollOnce();
  assert.equal(res.data![0].published, 0);
  const task = env.store.listTasksByProject("test-project")[0];
  assert.equal(task.status, "REPORT_READY");
  const refusal = env.ghCalls().find((c) => c.stdin && JSON.parse(c.stdin).body?.includes("prohibited files"));
  assert.ok(refusal, "prohibited-file refusal posted");
  env.cleanup();
});