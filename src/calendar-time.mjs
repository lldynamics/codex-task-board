// Calendar dates are civil dates in an explicit display zone, never UTC slices
// or values interpreted in the machine's implicit local timezone.
const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    let value;
    try {
      value = new Intl.DateTimeFormat("en-CA", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      });
    } catch { throw new RangeError("时区无效，请填写有效的 IANA 时区，例如 Asia/Shanghai。"); }
    // Bound this cache even when arbitrary user-supplied zone aliases are used.
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
    formatters.set(timeZone, value);
  }
  return formatters.get(timeZone);
}

function parts(instant, timeZone) {
  if (!timeZone || typeof timeZone !== "string" || timeZone !== timeZone.trim() || /^[+-]/.test(timeZone)) throw new RangeError("请选择有效的 IANA 时区。");
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new RangeError("日期时间无效。");
  return Object.fromEntries(formatter(timeZone).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function dateInZone(instant, timeZone) {
  const p = parts(instant, timeZone);
  return `${p.year.padStart(4, "0")}-${p.month}-${p.day}`;
}

export function timeInZone(instant, timeZone) {
  const p = parts(instant, timeZone);
  return `${p.hour}:${p.minute}`;
}

function civilDate(dateString) {
  if (typeof dateString !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) throw new RangeError("请选择有效日期。");
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || date.toISOString().slice(0, 10) !== dateString) throw new RangeError("请选择真实存在的日期。");
  return date;
}

export function addDays(dateString, amount) {
  if (!Number.isSafeInteger(amount)) throw new RangeError("天数必须是整数。");
  const date = civilDate(dateString);
  date.setUTCDate(date.getUTCDate() + amount);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new RangeError("日期超出支持范围。");
  return date.toISOString().slice(0, 10);
}

export function weekDates(anchorDate) {
  const weekday = civilDate(anchorDate).getUTCDay();
  const monday = addDays(anchorDate, -(weekday + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function localToInstant(dateString, timeString, timeZone) {
  const date = civilDate(dateString);
  if (typeof timeString !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeString)) throw new RangeError("请选择有效时间，格式为 HH:mm。");
  const [hour, minute] = timeString.split(":").map(Number);
  date.setUTCHours(hour, minute, 0, 0);
  const wall = date.getTime();
  // Collect offsets on both sides of a possible transition, then round-trip
  // every candidate. This detects DST gaps AND repeated wall times instead of
  // silently shifting a lesson or picking one of two indistinguishable times.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sampled = wall + hours * 3600000;
    const p = parts(sampled, timeZone);
    const projected = new Date(0);
    projected.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
    projected.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
    offsets.add(projected.getTime() - sampled);
  }
  const matches = [];
  for (const offset of offsets) {
    const instant = wall - offset;
    if (dateInZone(instant, timeZone) === dateString && timeInZone(instant, timeZone) === timeString) matches.push(instant);
  }
  if (matches.length === 0) throw new RangeError("该时区中这个本地时间不存在（可能遇到夏令时切换），请选择其他时间。");
  if (matches.length !== 1) throw new RangeError("该时区中这个时间出现两次（夏令时回拨），请选择其他时间或切换为 UTC 输入。");
  return new Date(matches[0]).toISOString();
}
