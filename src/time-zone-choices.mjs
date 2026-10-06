import { isValidTimeZone } from "./schedule-domain.mjs";
import { msg, fmt } from "./i18n.mjs";

const COMMON_TIME_ZONES = [
  ["Asia/Shanghai", "中国 · 上海"],
  ["Asia/Hong_Kong", "中国 · 香港"],
  ["Asia/Taipei", "中国 · 台北"],
  ["Asia/Singapore", "新加坡"],
  ["Asia/Tokyo", "日本 · 东京"],
  ["Asia/Seoul", "韩国 · 首尔"],
  ["Asia/Kolkata", "印度 · 加尔各答"],
  ["Asia/Dubai", "阿联酋 · 迪拜"],
  ["Europe/London", "英国 · 伦敦"],
  ["Europe/Paris", "法国 · 巴黎"],
  ["Europe/Berlin", "德国 · 柏林"],
  ["America/New_York", "美国 · 纽约"],
  ["America/Chicago", "美国 · 芝加哥"],
  ["America/Denver", "美国 · 丹佛"],
  ["America/Los_Angeles", "美国 · 洛杉矶"],
  ["Australia/Sydney", "澳大利亚 · 悉尼"],
  ["Pacific/Auckland", "新西兰 · 奥克兰"],
  ["UTC", "协调世界时"],
];
const REGION_LABELS = {
  Africa: "非洲", America: "美洲", Antarctica: "南极洲", Arctic: "北极地区",
  Asia: "亚洲", Atlantic: "大西洋", Australia: "澳大利亚", Europe: "欧洲",
  Indian: "印度洋", Pacific: "太平洋",
};

// Keep option values exactly as saved. Intl's supported list excludes some
// valid aliases (and UTC), so local/current values must be added separately.
export function timeZoneChoices({ timeZone, intl = Intl, i18n } = {}) {
  let localZone;
  let supported = [];
  try { localZone = new intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* Common choices remain usable. */ }
  try { supported = intl.supportedValuesOf?.("timeZone") || []; } catch { /* Older hosts may not enumerate zones. */ }
  const seen = new Set();
  const label = (value, name) => `${value === localZone ? "本机时区 · " : ""}${name ? `${name}（${value}）` : value.replaceAll("_", " ")}`;
  const displayLabel = (value, name, retained = false) => fmt(() => `${retained && value === timeZone && value !== localZone ? i18n.t("当前显示 · ") : ""}${value === localZone ? i18n.t("本机时区 · ") : ""}${name ? i18n.t("timezone.named", { name: i18n.t(name), value }) : value.replaceAll("_", " ")}`);
  const common = COMMON_TIME_ZONES.filter(([value]) => isValidTimeZone(value)).map(([value, name]) => {
    seen.add(value);
    return { value, label: label(value, name), ...(i18n ? { displayLabel: displayLabel(value, name) } : {}) };
  });
  const retained = [];
  for (const value of [timeZone, localZone]) {
    if (!isValidTimeZone(value) || seen.has(value)) continue;
    seen.add(value);
    retained.push({ value, label: `${value === timeZone && value !== localZone ? "当前显示 · " : ""}${label(value)}`, ...(i18n ? { displayLabel: displayLabel(value, null, true) } : {}) });
  }
  const groups = [{ label: "常用时区", options: common, ...(i18n ? { displayLabel: msg("常用时区") } : {}) }];
  if (retained.length) groups.push({ label: "当前与本机时区", options: retained, ...(i18n ? { displayLabel: msg("当前与本机时区") } : {}) });
  const regions = new Map();
  for (const value of [...supported].sort((a, b) => a.localeCompare(b, "en"))) {
    if (!isValidTimeZone(value) || seen.has(value)) continue;
    seen.add(value);
    const region = value.split("/")[0];
    if (!regions.has(region)) regions.set(region, []);
    regions.get(region).push({ value, label: label(value), ...(i18n ? { displayLabel: displayLabel(value) } : {}) });
  }
  for (const [region, entries] of regions) groups.push({ label: `其他时区 · ${REGION_LABELS[region] || region}`, options: entries, ...(i18n ? { displayLabel: msg("其他时区 · {p1}", { p1: msg(REGION_LABELS[region] || region) }) } : {}) });
  return groups;
}
