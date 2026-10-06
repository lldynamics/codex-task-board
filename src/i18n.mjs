import zh from "./locales/zh.mjs";
import en from "./locales/en.mjs";
import { englishPluralTemplate } from "./locales/en-plurals.mjs";

export const LOCALE_PREFERENCE_KEY = "codex-task-board:locale:v1";
export const SUPPORTED_LOCALES = Object.freeze(["zh", "en"]);
export const LOCALE_TAGS = Object.freeze({ zh: "zh-CN", en: "en-US" });
export const CATALOGS = Object.freeze({ zh, en });

const instances = new WeakMap();
const MESSAGE = Symbol("task-board-system-message");
const FORMATTED = Symbol("task-board-formatted-message");
const displayAttributes = new Set(["aria-label", "aria-description", "placeholder", "title", "alt", "label"]);
const isText = (node) => node?.nodeType === 3;
const resolved = (value) => typeof value === "function" ? value() : value;

export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const language = value.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(language) ? language : null;
}

export function msg(key, parameters = {}) {
  if (typeof key !== "string") throw new TypeError("A translation key is required");
  return Object.freeze({ [MESSAGE]: true, key, parameters });
}

export const isMessage = (value) => Boolean(value && value[MESSAGE] === true);
export function fmt(format) {
  if (typeof format !== "function") throw new TypeError("A display formatter is required");
  return Object.freeze({ [FORMATTED]: true, format });
}
const isFormatted = (value) => Boolean(value && value[FORMATTED] === true);

function interpolate(template, parameters, translate) {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name) =>
    Object.hasOwn(parameters, name) ? (isMessage(parameters[name]) ? translate(parameters[name].key, parameters[name].parameters) : String(parameters[name] ?? "")) : placeholder);
}

/** One explicitly-bound translation context per document, with no shared locale. */
export function createI18n(document, options = {}) {
  if (!document?.documentElement) throw new TypeError("An HTML document is required");
  const existing = instances.get(document);
  if (existing) return existing;
  let storage;
  try { storage = Object.hasOwn(options, "storage") ? options.storage : document.defaultView?.localStorage; } catch { /* Storage may be denied in a host panel. */ }
  let saved;
  try { saved = normalizeLocale(storage?.getItem(LOCALE_PREFERENCE_KEY)); } catch { /* Locale never depends on persistent storage. */ }
  let language;
  try { language = options.navigatorLanguage ?? document.defaultView?.navigator?.language; } catch { /* Unsupported languages use English. */ }
  let locale = normalizeLocale(options.locale) || saved || normalizeLocale(language) || "en";
  let disposed = false;
  let staticBound = false;
  const bindings = new Set();
  const finalized = typeof FinalizationRegistry === "function" ? new FinalizationRegistry((reference) => bindings.delete(reference)) : null;
  const slots = new WeakMap();
  const listeners = new Set();

  function t(key, parameters = {}) {
    if (typeof key !== "string") throw new TypeError("A translation key is required");
    const catalog = CATALOGS[locale];
    const values = resolved(parameters) || {};
    const template = Object.hasOwn(catalog, key) ? catalog[key] : key;
    return interpolate(locale === "en" ? englishPluralTemplate(key, values, template) : template, values, t);
  }
  function text(value) {
    if (isMessage(value)) return t(value.key, value.parameters);
    if (isFormatted(value)) return text(value.format(api));
    return String(value ?? "");
  }
  function assertLeaf(node) {
    if (!node || node.ownerDocument !== document) throw new TypeError("Bindings must belong to this document");
    if (!isText(node) && (node.childElementCount || ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName))) {
      throw new TypeError("Bind a text leaf or a dedicated label span; control values and child elements are preserved");
    }
  }
  function put(node, slot, format, write) {
    if (disposed) throw new Error("Translation context has been disposed");
    let owned = slots.get(node);
    if (!owned) { owned = new Map(); slots.set(node, owned); }
    const old = owned.get(slot);
    if (old) { bindings.delete(old.reference); finalized?.unregister(old.reference); }
    const target = typeof WeakRef === "function" ? new WeakRef(node) : { deref: () => node };
    const binding = { target, slot, format, write };
    const reference = typeof WeakRef === "function" ? new WeakRef(binding) : { deref: () => binding };
    binding.reference = reference;
    owned.set(slot, binding); bindings.add(reference);
    finalized?.register(binding, reference, reference);
    write(node, format());
    return () => {
      bindings.delete(reference); finalized?.unregister(reference);
      if (owned.get(slot) === binding) owned.delete(slot);
    };
  }
  function bindFormatText(node, format) {
    assertLeaf(node);
    return put(node, "text", () => text(format(api)), (target, text) => {
      if (isText(target)) target.data = text;
      else target.textContent = text;
    });
  }
  function bindText(node, key, parameters = {}) { return bindFormatText(node, () => t(key, parameters)); }
  function setText(node, value) {
    if (isMessage(value)) return bindText(node, value.key, value.parameters);
    if (isFormatted(value)) return bindFormatText(node, () => text(value));
    userText(node, value);
    return () => {};
  }
  function bindFormatAttr(node, name, format) {
    if (!node || node.ownerDocument !== document || !displayAttributes.has(name)) throw new TypeError("Only display attributes may be translated");
    return put(node, `attribute:${name}`, () => String(format(api) ?? ""), (target, text) => target.setAttribute(name, text));
  }
  function bindAttr(node, name, key, parameters = {}) { return bindFormatAttr(node, name, () => t(key, parameters)); }
  function userText(node, value) {
    assertLeaf(node);
    const old = slots.get(node)?.get("text");
    if (old) { bindings.delete(old.reference); finalized?.unregister(old.reference); slots.get(node).delete("text"); }
    if (isText(node)) node.data = String(value ?? "");
    else node.textContent = String(value ?? "");
  }
  function setLocale(value, { persist = true } = {}) {
    const next = normalizeLocale(value);
    if (!next || disposed) return false;
    if (persist) { try { storage?.setItem(LOCALE_PREFERENCE_KEY, next); } catch { /* A session-only switch remains available. */ } }
    if (next === locale) return true;
    locale = next;
    document.documentElement.lang = LOCALE_TAGS[locale];
    for (const reference of bindings) {
      const binding = reference.deref();
      if (!binding) { bindings.delete(reference); continue; }
      const node = binding.target.deref();
      if (!node?.isConnected) {
        bindings.delete(reference); finalized?.unregister(reference);
        if (node && slots.get(node)?.get(binding.slot) === binding) slots.get(node).delete(binding.slot);
        continue;
      }
      binding.write(node, binding.format());
    }
    for (const listener of listeners) listener(locale);
    return true;
  }
  const api = {
    get locale() { return locale; },
    get intlLocale() { return LOCALE_TAGS[locale]; },
    t, text, bindText, bindAttr, bindFormatText, bindFormatAttr, setText, userText, setLocale,
    date(value, settings = {}) { return new Intl.DateTimeFormat(LOCALE_TAGS[locale], settings).format(new Date(value)); },
    number(value, settings = {}) { return new Intl.NumberFormat(LOCALE_TAGS[locale], settings).format(value); },
    relative(value, unit, settings = {}) { return new Intl.RelativeTimeFormat(LOCALE_TAGS[locale], settings).format(value, unit); },
    bindDocument() {
      if (staticBound) return;
      staticBound = true;
      for (const node of document.querySelectorAll("[data-i18n]")) bindText(node, node.getAttribute("data-i18n"));
      for (const name of displayAttributes) for (const node of document.querySelectorAll(`[data-i18n-${name}]`)) bindAttr(node, name, node.getAttribute(`data-i18n-${name}`));
      const selectors = [...document.querySelectorAll("[data-locale-select]")];
      for (const select of selectors) {
        select.value = locale;
        select.addEventListener("change", () => setLocale(select.value));
      }
      listeners.add(() => { for (const select of selectors) select.value = locale; });
      const prompt = document.querySelector("[data-learning-prompt-key]");
      if (prompt) prompt.value = t(prompt.getAttribute("data-learning-prompt-key"));
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { disposed = true; bindings.clear(); listeners.clear(); if (instances.get(document) === api) instances.delete(document); },
  };
  instances.set(document, api);
  document.documentElement.lang = LOCALE_TAGS[locale];
  return api;
}

export function i18nFor(document, options) { return instances.get(document) || createI18n(document, options); }
