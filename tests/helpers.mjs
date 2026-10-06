// Shared test utilities. Test files keep their own fixtures; only these generic
// waiting helpers were previously copied into many files.
import assert from "node:assert/strict";

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function waitFor(predicate, message = "Asynchronous operation must settle", timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), message);
}
