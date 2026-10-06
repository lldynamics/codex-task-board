import test from "node:test";
import assert from "node:assert/strict";
import { timeZoneChoices } from "../src/time-zone-choices.mjs";
import { isValidTimeZone } from "../src/schedule-domain.mjs";

const options = (groups) => groups.flatMap((group) => group.options);
function hostIntl(localZone, supported) {
  return {
    DateTimeFormat: class { resolvedOptions() { return { timeZone: localZone }; } },
    ...(supported === undefined ? {} : { supportedValuesOf: () => supported }),
  };
}

test("time-zone choices use Chinese common labels, mark the actual host zone and include UTC once", () => {
  const groups = timeZoneChoices({ timeZone: "Asia/Shanghai", intl: hostIntl("Asia/Tokyo", ["Asia/Tokyo", "Europe/London", "UTC"]) });
  assert.equal(groups[0].label, "常用时区");
  const entries = options(groups);
  assert.match(entries.find((entry) => entry.value === "Asia/Shanghai").label, /中国 · 上海/);
  assert.match(entries.find((entry) => entry.value === "Asia/Tokyo").label, /^本机时区 · 日本 · 东京/);
  assert.match(entries.find((entry) => entry.value === "UTC").label, /协调世界时/);
  assert.equal(new Set(entries.map((entry) => entry.value)).size, entries.length);
});

test("saved aliases and less-common host zones remain selectable even when the host cannot enumerate zones", () => {
  for (const saved of ["US/Pacific", "Etc/GMT+5", "America/Argentina/Salta"]) {
    const entries = options(timeZoneChoices({ timeZone: saved, intl: hostIntl("Pacific/Chatham") }));
    assert.equal(entries.filter((entry) => entry.value === saved).length, 1);
    assert.match(entries.find((entry) => entry.value === saved).label, /^当前显示/);
    assert.match(entries.find((entry) => entry.value === "Pacific/Chatham").label, /^本机时区/);
    assert.ok(entries.every((entry) => isValidTimeZone(entry.value)));
  }
});

test("enumerated zones are grouped by region while invalid current, host and candidate values are excluded", () => {
  const groups = timeZoneChoices({ timeZone: "+08:00", intl: hostIntl("Mars/Olympus", ["Pacific/Chatham", "America/Argentina/Salta", "Mars/Olympus"]) });
  const entries = options(groups);
  assert.ok(groups.find((group) => group.label === "其他时区 · 美洲").options.some((entry) => entry.value === "America/Argentina/Salta"));
  assert.ok(groups.find((group) => group.label === "其他时区 · 太平洋").options.some((entry) => entry.value === "Pacific/Chatham"));
  assert.equal(entries.some((entry) => entry.value === "+08:00" || entry.value === "Mars/Olympus"), false);
});

test("all runtime-supported zones and an existing alias are offered without duplicate exact values", () => {
  const entries = options(timeZoneChoices({ timeZone: "US/Pacific" }));
  const values = new Set(entries.map((entry) => entry.value));
  for (const zone of Intl.supportedValuesOf("timeZone")) assert.equal(values.has(zone), true, zone);
  assert.equal(values.has("US/Pacific"), true);
  assert.equal(values.has(new Intl.DateTimeFormat().resolvedOptions().timeZone), true);
  assert.equal(values.size, entries.length);
});

test("the default display zone follows the machine and falls back to UTC", async () => {
  const { systemTimeZone } = await import("../src/schedule-domain.mjs");
  const fake = (timeZone) => ({ DateTimeFormat: function () { return { resolvedOptions: () => ({ timeZone }) }; } });
  assert.equal(systemTimeZone(fake("America/New_York")), "America/New_York");
  assert.equal(systemTimeZone(fake("Not/AZone")), "UTC");
  assert.equal(systemTimeZone(fake(undefined)), "UTC");
  assert.equal(systemTimeZone({ DateTimeFormat() { throw new Error("unavailable"); } }), "UTC");
});
