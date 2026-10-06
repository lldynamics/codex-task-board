import test from "node:test";
import assert from "node:assert/strict";
import {
  createWriteSlot, transitionWrite, transitionWrites, canRetrySlot, canDismissSlot,
  slotUncertain, slotExpired, beginActivity, endActivity,
} from "../src/write-state.mjs";
import { createViewState } from "../src/view-state.mjs";
import { emptyBoard } from "../src/board.mjs";

const request = (type = "save_task", requestId = "request-1", expectedRevision = 3) => ({ requestId, expectedRevision, operation: { type, task: { title: "保留草稿" } } });
const failure = (code) => ({ type: "failure", payload: { ok: false, error: { code, message: "Host error" } } });

test("retained requests freeze operation, id, CAS and known-id snapshots independently of caller input", () => {
  const input = request();
  const knownIds = new Set(["existing"]);
  const slot = createWriteSlot(input, { knownIds });
  input.operation.task.title = "later edit";
  input.expectedRevision = 9;
  knownIds.add("later creation");
  assert.equal(slot.request.operation.task.title, "保留草稿");
  assert.equal(slot.request.expectedRevision, 3);
  assert.deepEqual([...slot.knownIds], ["existing"]);
  assert.throws(() => { slot.request.operation.task.title = "replace"; }, TypeError);
  assert.strictEqual(transitionWrite(slot, failure("SAVE_FAILED")).request, slot.request);
});

for (const code of ["BUSY", "SAVE_FAILED", "NOT_FOUND", "REQUEST_ID_REUSE", "INVALID_INPUT", "CAPACITY_EXCEEDED", "INVALID_STORE", "SCHEDULE_CONFLICT", "SESSION_LOCKED"]) {
  test(`unknown write followed by ${code} keeps the original request and remains uncertain`, () => {
    const unknown = transitionWrite(createWriteSlot(request()), { type: "unknown" });
    const retry = transitionWrite(unknown, failure(code));
    const refreshed = transitionWrite(retry, { type: "refreshed", request: request("save_task", "new-id", 20) });
    assert.equal(retry.phase, "uncertain");
    assert.strictEqual(refreshed.request, unknown.request);
    assert.equal(canRetrySlot(refreshed), true);
    assert.equal(canDismissSlot(refreshed), false);
    assert.equal(transitionWrite(refreshed, { type: "dismiss" }).phase, "uncertain");
  });
}

test("a confirmed schedule rejection permits editing again without treating it as a lost response", () => {
  for (const code of ["SCHEDULE_CONFLICT", "SESSION_LOCKED"]) {
    const slot = transitionWrite(createWriteSlot(request("save_session")), failure(code));
    assert.equal(slotUncertain(slot), false);
    assert.equal(canDismissSlot(slot), true);
    assert.equal(transitionWrite(slot, { type: "dismiss" }), null);
  }
});

test("only a validated revision conflict releases an unknown write into explicit refresh", () => {
  const unknown = transitionWrite(createWriteSlot(request()), { type: "unknown" });
  const malformed = transitionWrite(unknown, { type: "failure", payload: { ok: false, error: { code: "REVISION_CONFLICT" } } });
  assert.equal(malformed.phase, "uncertain");
  assert.equal(transitionWrite(unknown, failure("NEW_HOST_ERROR")).phase, "uncertain");
  const conflict = transitionWrite(unknown, failure("REVISION_CONFLICT"));
  assert.equal(conflict.phase, "refresh-required");
  assert.equal(canRetrySlot(conflict), false);
  const refreshed = transitionWrite(conflict, { type: "refreshed", request: request("save_task", "new-id", 10) });
  assert.equal(refreshed.phase, "ready");
  assert.equal(refreshed.request.requestId, "new-id");
  assert.equal(refreshed.request.expectedRevision, 10);
});

test("expired writes reject replay and regenerated mutations until explicit refresh, review and end", () => {
  const expired = transitionWrite(createWriteSlot(request()), failure("REQUEST_EXPIRED"));
  assert.equal(slotExpired(expired), true);
  assert.equal(slotUncertain(expired), true);
  assert.equal(canRetrySlot(expired), false);
  assert.equal(canDismissSlot(expired), false);
  for (const event of [{ type: "confirmed" }, { type: "unknown" }, failure("REVISION_CONFLICT"), { type: "reviewed", checked: true }, { type: "end" }]) {
    assert.strictEqual(transitionWrite(expired, event), expired);
  }
  const read = transitionWrite(expired, { type: "refreshed", request: request("save_task", "forbidden-id", 99) });
  assert.equal(read.phase, "expired-needs-review");
  assert.strictEqual(read.request, expired.request);
  assert.strictEqual(transitionWrite(read, { type: "end" }), read);
  const reviewed = transitionWrite(read, { type: "reviewed", checked: true });
  assert.equal(transitionWrite(reviewed, { type: "reviewed", checked: false }).phase, "expired-needs-review");
  assert.equal(transitionWrite(reviewed, { type: "end" }), null);
});

test("save, move and action retain independent slots across failures and confirmations", () => {
  const writes = {
    save: createWriteSlot(request()), move: createWriteSlot(request("move_task", "move-id")),
    action: createWriteSlot(request("archive_task", "archive-id")),
  };
  const failedSave = transitionWrites(writes, "save", failure("SAVE_FAILED"));
  const unknownMove = transitionWrites(failedSave, "move", { type: "unknown" });
  assert.equal(unknownMove.save.phase, "retryable");
  assert.equal(unknownMove.move.phase, "uncertain");
  assert.strictEqual(unknownMove.action, writes.action);
  const confirmed = transitionWrites(unknownMove, "move", { type: "confirmed" });
  assert.equal(confirmed.move, null);
  assert.strictEqual(confirmed.save, unknownMove.save);
  assert.strictEqual(confirmed.action, writes.action);
});

test("ordinary refresh cannot rebase a destructive restore conflict", () => {
  const original = transitionWrite(createWriteSlot(request("restore_board")), failure("REVISION_CONFLICT"));
  const refreshed = transitionWrite(original, { type: "refreshed", request: request("restore_board", "new-id", 50) });
  assert.strictEqual(refreshed, original);
  assert.equal(canRetrySlot(refreshed), false);
  const newPreviewIntent = createWriteSlot(request("restore_board", "preview-id", 50));
  assert.equal(canRetrySlot(newPreviewIntent), true);
  assert.equal(newPreviewIntent.request.expectedRevision, 50);
});

test("all asynchronous work shares one activity while write slots may coexist", () => {
  const state = createViewState(emptyBoard());
  state.writes.save = createWriteSlot(request());
  state.writes.move = createWriteSlot(request("move_task", "move-id"));
  assert.equal(beginActivity(state, "mutating", "move"), true);
  assert.equal(beginActivity(state, "reading"), false);
  assert.equal(beginActivity(state, "exporting"), false);
  assert.deepEqual(state.activity, { kind: "mutating", lane: "move" });
  endActivity(state);
  assert.equal(beginActivity(state, "reading"), true);
  assert.equal(state.writes.save.request.requestId, "request-1");
  assert.equal(state.writes.move.request.requestId, "move-id");
});
