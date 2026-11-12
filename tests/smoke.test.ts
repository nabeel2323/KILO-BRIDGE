"use strict";

import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_VERSION, LABELS, TASK_STATUSES } from "../src/types";

test("toolchain smoke: types module loads", () => {
  assert.equal(BRIDGE_VERSION, "1.0.0");
  assert.equal(LABELS.length, 10);
  assert.ok(TASK_STATUSES.includes("REPORT_READY"));
});