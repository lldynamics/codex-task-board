// A retained request belongs to one lane. A read notification never advances it.
export const WRITE_LANES = Object.freeze(["save", "move", "action"]);
export const FAILURE_CODES = Object.freeze([
  "REVISION_CONFLICT", "REQUEST_ID_REUSE", "BUSY", "INVALID_STORE", "SAVE_FAILED",
  "CAPACITY_EXCEEDED", "REQUEST_EXPIRED", "NOT_FOUND", "INVALID_INPUT", "SCHEDULE_CONFLICT", "SESSION_LOCKED",
]);
const expiredPhases = new Set(["expired-needs-refresh", "expired-needs-review", "expired-reviewed"]);

function freeze(value) {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export function createWriteSlot(request, { knownIds = null } = {}) {
  return {
    phase: "ready", request: freeze(structuredClone(request)),
    knownIds: knownIds ? new Set(knownIds) : null, errorCode: null,
  };
}

export const slotExpired = (slot) => !!slot && expiredPhases.has(slot.phase);
export const slotUncertain = (slot) => !!slot && (slot.phase === "uncertain" || slotExpired(slot));
export const slotNeedsRefresh = (slot) => slot?.phase === "refresh-required";
export const canRetrySlot = (slot) => !!slot && ["ready", "retryable", "uncertain"].includes(slot.phase);
export const canDismissSlot = (slot) => !!slot && !slotUncertain(slot);

// Only an explicit, well-formed conflict follows the host's receipt lookup and
// can prove an unknown request was not applied. Earlier business errors cannot.
export function validatedFailureCode(payload) {
  return payload?.ok === false && FAILURE_CODES.includes(payload.error?.code)
    && typeof payload.error?.message === "string" ? payload.error.code : null;
}

export function transitionWrite(slot, event) {
  if (!slot) return null;
  if (event.type === "confirmed") return slotExpired(slot) ? slot : null;
  if (slotExpired(slot)) {
    if (event.type === "refreshed" && slot.phase === "expired-needs-refresh") return { ...slot, phase: "expired-needs-review" };
    if (event.type === "reviewed" && slot.phase !== "expired-needs-refresh") return { ...slot, phase: event.checked ? "expired-reviewed" : "expired-needs-review" };
    if (event.type === "end" && slot.phase === "expired-reviewed") return null;
    return slot;
  }
  if (event.type === "unknown") return { ...slot, phase: "uncertain", errorCode: null };
  if (event.type === "failure") {
    const code = validatedFailureCode(event.payload);
    if (code === "REQUEST_EXPIRED") return { ...slot, phase: "expired-needs-refresh", errorCode: code };
    if (code === "REVISION_CONFLICT") return { ...slot, phase: "refresh-required", errorCode: code };
    if (slot.phase === "uncertain" || !code) return { ...slot, phase: "uncertain", errorCode: code };
    return { ...slot, phase: ["REQUEST_ID_REUSE", "NOT_FOUND"].includes(code) ? "refresh-required" : "retryable", errorCode: code };
  }
  if (event.type === "refreshed" && slot.phase !== "uncertain") {
    // A destructive restore requires a fresh host preview rather than new CAS.
    if (slot.request.operation.type === "restore_board") return slot;
    if (!event.request) return slot;
    return createWriteSlot(event.request, { knownIds: slot.knownIds });
  }
  if (event.type === "dismiss" && canDismissSlot(slot)) return null;
  return slot;
}

export function transitionWrites(writes, lane, event) {
  if (!WRITE_LANES.includes(lane)) throw new TypeError("Unknown write lane");
  return { ...writes, [lane]: transitionWrite(writes[lane], event) };
}

export const isMutating = (state, lane) => state.activity.kind === "mutating" && (!lane || state.activity.lane === lane);
export const isReading = (state) => state.activity.kind === "reading";
export const isDataBusy = (state) => ["exporting", "previewing"].includes(state.activity.kind);
export const isBusy = (state) => state.activity.kind !== "idle";
export const saveFrozen = (state) => slotUncertain(state.writes.save);
export const saveNeedsRefresh = (state) => slotNeedsRefresh(state.writes.save) || state.editor.availability === "missing";
export const hasExpiredWrites = (state) => WRITE_LANES.some((lane) => slotExpired(state.writes[lane]));
export const expiredNeedsRefresh = (state) => WRITE_LANES.some((lane) => state.writes[lane]?.phase === "expired-needs-refresh");
export const expiredReviewed = (state) => WRITE_LANES.filter((lane) => slotExpired(state.writes[lane])).every((lane) => state.writes[lane].phase === "expired-reviewed");

export function beginActivity(state, kind, lane) {
  if (isBusy(state)) return false;
  state.activity = kind === "mutating" ? { kind, lane } : { kind };
  return true;
}

export function endActivity(state) { state.activity = { kind: "idle" }; }
