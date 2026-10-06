import test from "node:test";
import assert from "node:assert/strict";
import { dateInZone, timeInZone, localToInstant, weekDates, addDays } from "../src/calendar-time.mjs";

test("calendar dates use the selected zone across UTC midnight and the date line", () => {
  const instant = "2026-10-05T16:30:00.000Z";
  assert.equal(dateInZone(instant, "Asia/Shanghai"), "2026-10-06");
  assert.equal(timeInZone(instant, "Asia/Shanghai"), "00:30");
  assert.equal(dateInZone(instant, "America/Los_Angeles"), "2026-10-05");
  assert.equal(timeInZone(instant, "America/Los_Angeles"), "09:30");
  assert.equal(dateInZone("2026-10-05T10:30:00Z", "Pacific/Kiritimati"), "2026-10-06");
});

test("calendar weeks start Monday and cross month/year boundaries without local-clock arithmetic", () => {
  assert.deepEqual(weekDates("2027-01-03"), ["2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03"]);
  assert.equal(weekDates("2026-10-05")[0], "2026-10-05");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(addDays("2028-02-29", 1), "2028-03-01");
  for (const date of ["2026-02-29", "2026-13-01", "0000-01-01", "2026-1-01"]) assert.throws(() => weekDates(date), RangeError);
});

test("local scheduling round-trips ordinary, fractional-offset, and low-year times", () => {
  assert.equal(localToInstant("2026-10-06", "00:30", "Asia/Shanghai"), "2026-10-05T16:30:00.000Z");
  assert.equal(localToInstant("2026-10-06", "09:00", "Asia/Kathmandu"), "2026-10-06T03:15:00.000Z");
  assert.equal(localToInstant("2026-07-01", "20:00", "America/New_York"), "2026-07-02T00:00:00.000Z");
  assert.equal(localToInstant("0099-01-02", "12:30", "UTC"), "0099-01-02T12:30:00.000Z");
});

test("nonexistent and repeated DST times require a deliberate new choice", () => {
  assert.throws(() => localToInstant("2026-03-08", "02:30", "America/New_York"), /不存在/);
  assert.throws(() => localToInstant("2026-11-01", "01:30", "America/New_York"), /出现两次/);
  assert.equal(localToInstant("2026-03-08", "03:30", "America/New_York"), "2026-03-08T07:30:00.000Z");
  assert.throws(() => localToInstant("2026-10-04", "02:15", "Australia/Lord_Howe"), /不存在/);
  assert.throws(() => localToInstant("2026-04-05", "01:45", "Australia/Lord_Howe"), /出现两次/);
});

test("invalid wall dates, clocks, and zones are rejected without timezone fallback", () => {
  for (const clock of ["24:00", "12:60", "9:00", "12:00:00", ""]) assert.throws(() => localToInstant("2026-10-05", clock, "UTC"), RangeError);
  assert.throws(() => localToInstant("2026-04-31", "12:00", "UTC"), RangeError);
  assert.throws(() => localToInstant("2026-10-05", "12:00", "Invalid/Zone"), RangeError);
  assert.throws(() => localToInstant("2026-10-05", "12:00", "+08:00"), RangeError);
  assert.throws(() => dateInZone("2026-10-05T00:00:00Z", undefined), RangeError);
});
