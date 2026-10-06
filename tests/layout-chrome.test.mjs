import test from "node:test";
import assert from "node:assert/strict";
import { relativeCollectedTime } from "../src/view-codex-board.mjs";

test("collection age uses stable minute labels, including future or unknown timestamps", () => {
  const collected = "2026-10-06T00:00:00.000Z";
  const start = Date.parse(collected);
  for (const [elapsed, expected] of [[-60000, "刚刚采集"], [0, "刚刚采集"], [59000, "刚刚采集"], [60000, "1 分钟前"], [3599000, "59 分钟前"], [3600000, "1 小时前"], [86400000, "1 天前"]]) {
    assert.equal(relativeCollectedTime(collected, start + elapsed), expected);
  }
  assert.equal(relativeCollectedTime(undefined, start), "采集时间未知");
});
