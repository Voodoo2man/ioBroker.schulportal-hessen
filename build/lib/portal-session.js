"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var portal_session_exports = {};
__export(portal_session_exports, {
  PortalSession: () => PortalSession,
  PortalSessionError: () => PortalSessionError,
  classifyPortalStatus: () => classifyPortalStatus
});
module.exports = __toCommonJS(portal_session_exports);
var import_node_crypto = require("node:crypto");
const LOGIN_URL = new URL("https://login.schulportal.hessen.de/");
const CONNECT_URL = new URL("https://connect.schulportal.hessen.de/");
const START_URL = new URL("https://start.schulportal.hessen.de/");
const ALLOWED_HOSTS = /* @__PURE__ */ new Set([LOGIN_URL.hostname, CONNECT_URL.hostname, START_URL.hostname]);
const ADAPTER_USER_AGENT = "ioBroker.schulportal-hessen";
const DEFAULT_REQUEST_TIMEOUT_MS = 15e3;
const MAX_REQUEST_TIMEOUT_MS = 6e4;
const DEFAULT_SESSION_MAX_AGE_MS = 45 * 6e4;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_PREFIX_BYTES = 512;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const SESSION_KEY_BYTES = 46;
const CHALLENGE_BYTES = 48;
const COOKIE_PARENT_DOMAINS = /* @__PURE__ */ new Set(["hessen.de", "schulportal.hessen.de"]);
const MAX_COOKIE_COUNT = 100;
const MAX_COOKIE_VALUE_BYTES = 4096;
const MAX_COOKIE_HEADER_BYTES = 16 * 1024;
const MAX_USERNAME_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 4096;
const ALLOWED_GET_PATHS = /* @__PURE__ */ new Set([
  "/stundenplan.php",
  "/kalender.php",
  "/vertretungsplan.php",
  "/meinunterricht.php",
  "/lerngruppen.php",
  "/dateispeicher.php",
  "/benutzerverwaltung.php"
]);
const ALLOWED_GET_QUERY_KEYS = {
  "/stundenplan.php": /* @__PURE__ */ new Set(["a", "e", "k", "p"]),
  "/kalender.php": /* @__PURE__ */ new Set(["a", "export", "year"]),
  "/vertretungsplan.php": /* @__PURE__ */ new Set(["tag"]),
  "/meinunterricht.php": /* @__PURE__ */ new Set(["a", "id", "cacheBreaker", "jump"]),
  "/lerngruppen.php": /* @__PURE__ */ new Set(),
  "/dateispeicher.php": /* @__PURE__ */ new Set(["a", "folder", "q"]),
  "/benutzerverwaltung.php": /* @__PURE__ */ new Set(["a"])
};
const ERROR_MESSAGES = {
  "invalid-config": "Portal session configuration is invalid.",
  "invalid-target": "Portal request target is not allowed.",
  timeout: "Portal request timed out.",
  "network-error": "Portal request failed.",
  "authentication-failed": "Portal authentication failed.",
  "handshake-failed": "Portal session handshake failed.",
  "decode-failed": "Portal response decoding failed.",
  closed: "Portal session is closed."
};
class PortalSessionError extends Error {
  /**
   * Create an error that does not include credentials, URLs, or raw network messages.
   *
   * @param code Stable public error code.
   * @param diagnosticCode Safe protocol-phase diagnostic, when available.
   * @param httpStatus Numeric HTTP response status, when available.
   */
  constructor(code, diagnosticCode, httpStatus) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.diagnosticCode = diagnosticCode;
    this.httpStatus = httpStatus;
    this.name = "PortalSessionError";
  }
}
function classifyPortalStatus(status) {
  if (status >= 200 && status < 300) {
    return "success";
  }
  if (status === 401) {
    return "session-expired";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 404) {
    return "not-found";
  }
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 300 && status < 400) {
    return "redirect";
  }
  if (status >= 400 && status < 500) {
    return "client-error";
  }
  if (status >= 500 && status < 600) {
    return "server-error";
  }
  return "unknown";
}
class ResponseBodyTooLargeError extends Error {
  diagnostic;
  constructor(limitBytes, declaredContentLength, streamingExceededLimit, prefixClassification = "not-inspected") {
    super();
    this.name = "ResponseBodyTooLargeError";
    this.diagnostic = {
      limitBytes,
      ...declaredContentLength === void 0 ? {} : { declaredContentLength },
      streamingExceededLimit,
      prefixClassification
    };
  }
}
class PortalCookieJar {
  constructor(now) {
    this.now = now;
  }
  cookies = /* @__PURE__ */ new Map();
  clear() {
    this.cookies.clear();
  }
  store(url, headers) {
    var _a, _b;
    for (const header of getSetCookieValues(headers)) {
      const parts = header.split(";");
      const pair = (_b = (_a = parts.shift()) == null ? void 0 : _a.trim()) != null ? _b : "";
      const equalsIndex = pair.indexOf("=");
      if (equalsIndex < 1) {
        continue;
      }
      const name = pair.slice(0, equalsIndex).trim();
      const value = pair.slice(equalsIndex + 1).trim();
      if (!isCookieName(name) || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value) || Buffer.byteLength(value) > MAX_COOKIE_VALUE_BYTES) {
        continue;
      }
      let domain = url.hostname.toLowerCase();
      let hostOnly = true;
      let path = defaultCookiePath(url.pathname);
      let secure = false;
      let expiresAt = null;
      let maxAge = null;
      for (const rawAttribute of parts) {
        const separator = rawAttribute.indexOf("=");
        const attribute = (separator < 0 ? rawAttribute : rawAttribute.slice(0, separator)).trim().toLowerCase();
        const attributeValue = separator < 0 ? "" : rawAttribute.slice(separator + 1).trim();
        switch (attribute) {
          case "domain": {
            const candidate = attributeValue.replace(/^\./, "").toLowerCase();
            if (!isAllowedCookieDomain(candidate, url.hostname)) {
              domain = "";
              break;
            }
            domain = candidate;
            hostOnly = false;
            break;
          }
          case "path":
            if (attributeValue.startsWith("/")) {
              path = attributeValue;
            }
            break;
          case "secure":
            secure = true;
            break;
          case "max-age":
            if (/^-?\d+$/.test(attributeValue)) {
              const parsed = Number(attributeValue);
              if (Number.isFinite(parsed)) {
                maxAge = parsed;
              }
            }
            break;
          case "expires": {
            const parsed = Date.parse(attributeValue);
            if (Number.isFinite(parsed)) {
              expiresAt = parsed;
            }
            break;
          }
        }
      }
      if (!domain || secure && url.protocol !== "https:") {
        continue;
      }
      if (maxAge !== null) {
        expiresAt = this.now() + maxAge * 1e3;
      }
      const key = cookieKey(domain, path, name);
      if (expiresAt !== null && expiresAt <= this.now()) {
        this.cookies.delete(key);
        continue;
      }
      this.cookies.delete(key);
      this.cookies.set(key, { name, value, domain, hostOnly, path, secure, expiresAt });
    }
    this.prune();
  }
  header(url) {
    this.prune();
    const matches = [...this.cookies.values()].filter(
      (cookie) => ((cookie.hostOnly ? url.hostname === cookie.domain : domainMatches(url.hostname, cookie.domain)) || cookie.name === "sid" && cookie.hostOnly && ALLOWED_HOSTS.has(cookie.domain) && ALLOWED_HOSTS.has(url.hostname)) && url.pathname.startsWith(cookie.path) && (cookie.path.endsWith("/") || url.pathname.length === cookie.path.length || url.pathname[cookie.path.length] === "/") && (!cookie.secure || url.protocol === "https:")
    ).sort((left, right) => right.path.length - left.path.length);
    return matches.length ? matches.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") : void 0;
  }
  prune() {
    const now = this.now();
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
      }
    }
    let headerBytes = [...this.cookies.values()].reduce(
      (total, cookie) => total + Buffer.byteLength(`${cookie.name}=${cookie.value}`) + 2,
      0
    );
    while (this.cookies.size > MAX_COOKIE_COUNT || headerBytes > MAX_COOKIE_HEADER_BYTES) {
      const oldestKey = this.cookies.keys().next().value;
      if (oldestKey === void 0) {
        break;
      }
      const oldest = this.cookies.get(oldestKey);
      if (oldest) {
        headerBytes -= Buffer.byteLength(`${oldest.name}=${oldest.value}`) + 2;
      }
      this.cookies.delete(oldestKey);
    }
  }
}
function getSetCookieValues(headers) {
  const headersWithSetCookie = headers;
  if (typeof headersWithSetCookie.getSetCookie === "function") {
    return headersWithSetCookie.getSetCookie();
  }
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/) : [];
}
function isCookieName(name) {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}
function isAllowedCookieDomain(domain, sourceHost) {
  return (ALLOWED_HOSTS.has(domain) || COOKIE_PARENT_DOMAINS.has(domain)) && domainMatches(sourceHost, domain);
}
function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}
function defaultCookiePath(pathname) {
  if (!pathname.startsWith("/") || pathname === "/") {
    return "/";
  }
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}
function cookieKey(domain, path, name) {
  return `${domain}\0${path}\0${name}`;
}
function validateOption(value, fallback, max) {
  if (value === void 0) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new PortalSessionError("invalid-config");
  }
  return value;
}
function parseAllowedUrl(value, base) {
  let url;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value, base);
  } catch {
    throw new PortalSessionError("invalid-target");
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || url.port !== "" || url.username !== "" || url.password !== "") {
    throw new PortalSessionError("invalid-target");
  }
  return url;
}
function getReadTarget(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 8192 || !path.startsWith("/") || path.startsWith("//") || /[\\\r\n\0#]/.test(path)) {
    throw new PortalSessionError("invalid-target");
  }
  const url = parseAllowedUrl(path, START_URL);
  if (url.hostname !== START_URL.hostname || !isSafeReadTarget(url)) {
    throw new PortalSessionError("invalid-target");
  }
  return url;
}
function isSafeReadTarget(url) {
  var _a, _b, _c, _d, _e;
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return false;
  }
  const allowedKeys = ALLOWED_GET_QUERY_KEYS[pathname];
  if (!ALLOWED_GET_PATHS.has(pathname) || !allowedKeys) {
    return false;
  }
  const seenKeys = /* @__PURE__ */ new Set();
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || seenKeys.has(key)) {
      return false;
    }
    seenKeys.add(key);
  }
  const value = (key) => url.searchParams.get(key);
  const action = (_b = (_a = value("a")) == null ? void 0 : _a.toLowerCase()) != null ? _b : null;
  switch (pathname) {
    case "/stundenplan.php": {
      const classId = value("k");
      const studentId = value("p");
      const hasDetailQuery = action !== null || value("e") !== null || classId !== null || studentId !== null;
      if (!hasDetailQuery) {
        return true;
      }
      return action === "detail_klasse" && value("e") === "1" && classId !== null && /^[a-z0-9_-]{1,64}$/i.test(classId) && studentId !== null && /^\d{1,20}$/.test(studentId);
    }
    case "/kalender.php": {
      if (action !== null && action !== "export") {
        return false;
      }
      const exportType = (_d = (_c = value("export")) == null ? void 0 : _c.toLowerCase()) != null ? _d : null;
      const year = value("year");
      const hasExportArguments = exportType !== null && year !== null;
      return (action === "export" ? hasExportArguments : exportType === null && year === null) && (exportType === null || exportType === "csv" || exportType === "ical") && (year === null || /^(?:19|20|21)\d{2}$/.test(year));
    }
    case "/vertretungsplan.php":
      return value("tag") === null || isGermanDate((_e = value("tag")) != null ? _e : "");
    case "/meinunterricht.php": {
      const courseId = value("id");
      const cacheBreaker = value("cacheBreaker");
      const jump = value("jump");
      return (action === null || action === "view") && (action !== "view" || courseId !== null && /^\d{1,20}$/.test(courseId)) && (cacheBreaker === null || /^\d{1,16}$/.test(cacheBreaker)) && (jump === null || jump === "no") && (courseId === null || action === "view");
    }
    case "/lerngruppen.php":
      return url.search.length === 0;
    case "/dateispeicher.php": {
      const folder = value("folder");
      const query = value("q");
      return (action === null || action === "view" || action === "searchfiles") && (folder === null || /^\d{1,20}$/.test(folder)) && (query === null || query.length <= 256) && (action !== "searchfiles" || query !== null) && (action !== "view" || query === null);
    }
    case "/benutzerverwaltung.php":
      return action === "userdata";
    default:
      return false;
  }
}
function isGermanDate(value) {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) {
    return false;
  }
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function isPortalSubstitutionTag(value, normalizedDate) {
  const match = /^(\d{2})([._])(\d{2})\2(\d{4})$/.exec(value);
  return match !== null && isGermanDate(normalizedDate) && `${match[1]}.${match[3]}.${match[4]}` === normalizedDate;
}
function hasControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
function isSafeMessageSourceId(value) {
  return value.length > 0 && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 256 && Buffer.from(value, "utf8").toString("utf8") === value && value.trim() === value && !hasControlCharacters(value) && !/\s/u.test(value) && !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code >= 127 && code <= 159;
  });
}
function hasUnsafeMessageTextControlCharacters(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13 || code >= 127 && code <= 159;
  });
}
function isIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function createReadFormRequest(request, sessionKey, messageSourceIds) {
  var _a, _b;
  if (request.type === "calendar-events") {
    if (!isIsoDate(request.start) || !isIsoDate(request.end) || request.start > request.end || (Date.parse(`${request.end}T00:00:00Z`) - Date.parse(`${request.start}T00:00:00Z`)) / 864e5 > 500 || request.search !== void 0 && (typeof request.search !== "string" || request.search.length > 128 || hasControlCharacters(request.search))) {
      throw new PortalSessionError("invalid-target");
    }
    const url = new URL("/kalender.php", START_URL);
    for (const [key, value] of Object.entries({
      f: "getEvents",
      s: (_a = request.search) != null ? _a : "",
      start: request.start,
      end: request.end
    })) {
      url.searchParams.set(key, value);
    }
    const body = new URLSearchParams({
      f: "getEvents",
      start: request.start,
      end: request.end,
      s: (_b = request.search) != null ? _b : ""
    }).toString();
    return {
      url,
      body,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin"
      }
    };
  }
  if (request.type === "substitution-day" && isGermanDate(request.date) && isPortalSubstitutionTag(request.portalTag, request.date)) {
    const url = new URL("/vertretungsplan.php", START_URL);
    url.searchParams.set("a", "my");
    const body = new URLSearchParams({ tag: request.portalTag, ganzerPlan: "true" }).toString();
    return { url, body, headers: { "X-Requested-With": "XMLHttpRequest" } };
  }
  if (request.type === "message-headers") {
    const url = new URL("/nachrichten.php", START_URL);
    const body = new URLSearchParams({ a: "headers", getType: "All", last: "0" }).toString();
    return {
      url,
      body,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "X-Requested-With": "XMLHttpRequest"
      },
      decodeMessageHeaders: true
    };
  }
  if (request.type === "message-detail") {
    if (!/^[a-f0-9]{64}$/u.test(request.messageIdHash)) {
      throw new PortalSessionError("invalid-target");
    }
    const sourceId = messageSourceIds.get(request.messageIdHash);
    if (!sessionKey || !sourceId || !isSafeMessageSourceId(sourceId)) {
      throw new PortalSessionError("invalid-target");
    }
    const url = new URL("/nachrichten.php", START_URL);
    url.searchParams.set("a", "read");
    url.searchParams.set("msg", sourceId);
    const encryptedId = encryptOpenSslPayload(sourceId, sessionKey);
    const body = new URLSearchParams({ a: "read", uniqid: encryptedId }).toString();
    return {
      url,
      body,
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "X-Requested-With": "XMLHttpRequest"
      },
      messageDetail: { idHash: request.messageIdHash, sourceId }
    };
  }
  throw new PortalSessionError("invalid-target");
}
function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function isLoginHostRedirect(location, from) {
  try {
    const target = parseAllowedUrl(location, from);
    return target.hostname === LOGIN_URL.hostname || target.hostname === CONNECT_URL.hostname;
  } catch {
    return false;
  }
}
function responseResult(status, classification, contentType = null, body = new Uint8Array(), diagnostics = {}) {
  return { status, classification, contentType, body, ...diagnostics };
}
function getSafeContentLength(value) {
  if (value === null) {
    return void 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : void 0;
}
function findNextJsonObjectDelimiter(value, start) {
  let nestedDepth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index++) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      nestedDepth++;
    } else if (character === "}" || character === "]") {
      if (nestedDepth === 0) {
        return index;
      }
      nestedDepth--;
    } else if (character === "," && nestedDepth === 0) {
      return index + 1;
    }
  }
  return value.length;
}
function hasTopLevelRowsKey(prefix) {
  var _a, _b;
  let index = 1;
  while (index < prefix.length) {
    while (/\s|,/u.test((_a = prefix[index]) != null ? _a : "")) {
      index++;
    }
    if (prefix[index] !== '"') {
      return false;
    }
    const keyStart = ++index;
    let escaped = false;
    for (; index < prefix.length; index++) {
      const character = prefix[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        break;
      }
    }
    if (index >= prefix.length) {
      return false;
    }
    const key = prefix.slice(keyStart, index);
    index++;
    while (/\s/u.test((_b = prefix[index]) != null ? _b : "")) {
      index++;
    }
    if (prefix[index] !== ":") {
      return false;
    }
    if (key === "rows") {
      return true;
    }
    index = findNextJsonObjectDelimiter(prefix, index + 1);
  }
  return false;
}
function classifyResponsePrefix(prefix) {
  const text = Buffer.from(prefix).toString("utf8").replace(/^\uFEFF/u, "").trimStart();
  if (!text) {
    return "unknown";
  }
  if (text.startsWith("{")) {
    return hasTopLevelRowsKey(text) ? "json-object-with-rows" : "json-object";
  }
  if (text.startsWith("[")) {
    return "json-array";
  }
  if (/^(?:<!doctype\s+html\b|<(?:html|head|body|table|form|div|meta|script|link|main|section)\b)/iu.test(text)) {
    return "html";
  }
  const sample = Array.from(text.slice(0, 128));
  return sample.length > 0 && sample.every((character) => {
    var _a;
    const codePoint = (_a = character.codePointAt(0)) != null ? _a : 0;
    return codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32 && (codePoint < 128 || codePoint >= 160) && codePoint !== 65533;
  }) ? "plain-text" : "unknown";
}
async function cancelBody(response) {
  var _a;
  try {
    await ((_a = response.body) == null ? void 0 : _a.cancel());
  } catch {
  }
}
function deriveChallengeKeyAndIv(secret, salt) {
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < CHALLENGE_BYTES) {
    previous = (0, import_node_crypto.createHash)("md5").update(previous).update(secret).update(salt).digest();
    material = Buffer.concat([material, previous]);
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}
function encryptOpenSslPayload(plaintext, sessionKey) {
  const salt = (0, import_node_crypto.randomBytes)(8);
  const { key, iv } = deriveChallengeKeyAndIv(sessionKey, salt);
  const cipher = (0, import_node_crypto.createCipheriv)("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__"), salt, ciphertext]).toString("base64");
}
function verifyChallenge(challengeValue, sessionKey) {
  if (typeof challengeValue !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(challengeValue)) {
    return false;
  }
  const payload = Buffer.from(challengeValue, "base64");
  if (payload.length < 16 + 16 || payload.subarray(0, 8).toString("ascii") !== "Salted__") {
    return false;
  }
  try {
    const { key, iv } = deriveChallengeKeyAndIv(sessionKey, payload.subarray(8, 16));
    const decipher = (0, import_node_crypto.createDecipheriv)("aes-256-cbc", key, iv);
    const plaintext = Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]);
    return plaintext.length === SESSION_KEY_BYTES && (0, import_node_crypto.timingSafeEqual)(plaintext, sessionKey);
  } catch {
    return false;
  }
}
function isLoginPage(body, contentType) {
  const html = Buffer.from(body).toString("utf8").slice(0, MAX_AUTH_RESPONSE_BYTES).toLowerCase();
  if (!(contentType == null ? void 0 : contentType.toLowerCase().includes("html")) && !/^\s*(?:<!doctype\s+html|<html\b)/.test(html)) {
    return false;
  }
  const hasLoginForm = /<input\b[^>]*\bname\s*=\s*["']?user2["']?[^>]*>/.test(html) && /<input\b[^>]*\bname\s*=\s*["']?password["']?[^>]*>/.test(html);
  const visibleText = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ");
  return hasLoginForm || /\blogin\s+nötig\b|\bmuss(?:\s+man)?\s+eingeloggt\s+sein\b|\blogin\s+required\b|\bmust\s+be\s+logged\s+in\b/u.test(
    visibleText
  );
}
function decryptOpenSslPayload(encoded, sessionKey) {
  if (!sessionKey || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new PortalSessionError("decode-failed");
  }
  const payload = Buffer.from(encoded, "base64");
  if (payload.length < 32 || payload.subarray(0, 8).toString("ascii") !== "Salted__") {
    throw new PortalSessionError("decode-failed");
  }
  try {
    const { key, iv } = deriveChallengeKeyAndIv(sessionKey, payload.subarray(8, 16));
    const decipher = (0, import_node_crypto.createDecipheriv)("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString("utf8");
  } catch {
    throw new PortalSessionError("decode-failed");
  }
}
function decodeMessageHeaderRows(body, sessionKey) {
  let wrapper;
  try {
    wrapper = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new PortalSessionError("decode-failed", "message-headers-wrapper-invalid");
  }
  if (!isRecord(wrapper)) {
    throw new PortalSessionError("decode-failed", "message-headers-wrapper-invalid");
  }
  if (!Object.hasOwn(wrapper, "rows")) {
    throw new PortalSessionError("decode-failed", "message-headers-rows-missing");
  }
  if (typeof wrapper.rows !== "string") {
    throw new PortalSessionError("decode-failed", "message-headers-rows-invalid");
  }
  let decryptedRows;
  try {
    decryptedRows = decryptOpenSslPayload(wrapper.rows, sessionKey);
  } catch {
    throw new PortalSessionError("decode-failed", "message-headers-decryption-failed");
  }
  let rows;
  try {
    rows = JSON.parse(decryptedRows);
  } catch {
    throw new PortalSessionError("decode-failed", "message-headers-decrypted-json-invalid");
  }
  if (!Array.isArray(rows) || !rows.every(isRecord)) {
    throw new PortalSessionError("decode-failed", "message-headers-decrypted-shape-invalid");
  }
  const sourceIds = /* @__PURE__ */ new Map();
  const metadata = rows.map((row) => {
    const sourceId = row.Uniquid;
    if (!(typeof sourceId === "string" && sourceId.trim() && sourceId.length <= 256) && !(typeof sourceId === "number" && Number.isSafeInteger(sourceId))) {
      throw new PortalSessionError("decode-failed", "message-headers-row-id-invalid");
    }
    const sourceIdText = String(sourceId);
    const idHash = (0, import_node_crypto.createHash)("sha256").update(sourceIdText).digest("hex");
    const record = { id: idHash };
    if (row.Papierkorb === "nein" && messageSourceId(sourceId) !== null) {
      sourceIds.set(idHash, sourceIdText);
    }
    for (const [sourceName, targetName] of [
      ["Betreff", "subject"],
      ["kuerzel", "senderShortName"],
      ["SenderName", "senderName"],
      ["Datum", "date"]
    ]) {
      const value = row[sourceName];
      if (typeof value === "string" && value.length <= 8192 && !hasControlCharacters(value)) {
        record[targetName] = value;
      }
    }
    if (row.unread === 0 || row.unread === 1) {
      record.unread = row.unread === 1;
    }
    if (row.Papierkorb === "ja" || row.Papierkorb === "nein") {
      record.hidden = row.Papierkorb === "ja";
    }
    return record;
  });
  return { body: Buffer.from(JSON.stringify(metadata), "utf8"), sourceIds };
}
function decodeMessageDetail(body, sessionKey, context) {
  let wrapper;
  try {
    wrapper = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new PortalSessionError("decode-failed", "message-detail-wrapper-invalid");
  }
  if (!isRecord(wrapper)) {
    throw new PortalSessionError("decode-failed", "message-detail-wrapper-invalid");
  }
  if (!Object.hasOwn(wrapper, "message")) {
    throw new PortalSessionError("decode-failed", "message-detail-message-missing");
  }
  if (typeof wrapper.message !== "string" || !Number.isSafeInteger(wrapper.time) || wrapper.time < 0) {
    throw new PortalSessionError("decode-failed", "message-detail-wrapper-invalid");
  }
  let decoded;
  try {
    decoded = decryptOpenSslPayload(wrapper.message, sessionKey);
  } catch {
    throw new PortalSessionError("decode-failed", "message-detail-decryption-failed");
  }
  let conversation;
  try {
    conversation = JSON.parse(decoded);
  } catch {
    throw new PortalSessionError("decode-failed", "message-detail-json-invalid");
  }
  if (!isRecord(conversation)) {
    throw new PortalSessionError("decode-failed", "message-detail-shape-invalid");
  }
  const parent = parseMessageDetailItem(conversation);
  const sourceId = messageSourceId(conversation.Uniquid);
  const statistics = conversation.statistik;
  if (!parent || !sourceId || (0, import_node_crypto.createHash)("sha256").update(sourceId).digest("hex") !== context.idHash || sourceId !== context.sourceId || !Array.isArray(conversation.reply) || conversation.reply.length > 100 || !conversation.reply.every(isRecord) || !isRecord(statistics) || !isNonNegativeSafeInteger(statistics.teilnehmer) || !isNonNegativeSafeInteger(statistics.betreuer) || !isNonNegativeSafeInteger(statistics.eltern) || !isJaNein(conversation.groupOnly) || !isJaNein(conversation.privateAnswerOnly) || !isJaNein(conversation.noAnswerAllowed)) {
    throw new PortalSessionError("decode-failed", "message-detail-shape-invalid");
  }
  const replies = conversation.reply.map((reply) => {
    const parsed = parseMessageDetailItem(reply);
    if (!parsed || !messageSourceId(reply.Uniquid)) {
      throw new PortalSessionError("decode-failed", "message-detail-shape-invalid");
    }
    return parsed;
  });
  return Buffer.from(
    JSON.stringify({
      id: context.idHash,
      ...parent,
      replies,
      time: wrapper.time,
      groupChat: conversation.groupOnly === "ja",
      onlyPrivateAnswers: conversation.privateAnswerOnly === "ja",
      noReply: conversation.noAnswerAllowed === "ja",
      participantCounts: {
        students: statistics.teilnehmer,
        teachers: statistics.betreuer,
        parents: statistics.eltern
      }
    }),
    "utf8"
  );
}
function parseMessageDetailItem(value) {
  const id = messageSourceId(value.Uniquid);
  if (!id || typeof value.Datum !== "string" || value.Datum.length > 8192 || hasControlCharacters(value.Datum) || typeof value.username !== "string" || value.username.length > 8192 || hasControlCharacters(value.username) || typeof value.own !== "boolean" || typeof value.Inhalt !== "string" || value.Inhalt.length > 4 * 1024 * 1024 || hasUnsafeMessageTextControlCharacters(value.Inhalt)) {
    return null;
  }
  return {
    id: (0, import_node_crypto.createHash)("sha256").update(id).digest("hex"),
    date: value.Datum,
    username: value.username,
    own: value.own,
    content: value.Inhalt
  };
}
function messageSourceId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return typeof value === "string" && isSafeMessageSourceId(value) ? value : null;
}
function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isJaNein(value) {
  return value === "ja" || value === "nein";
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeEncryptedFragments(body, sessionKey) {
  const source = Buffer.from(body).toString("utf8");
  if (!/<encoded(?:\s[^>]*)?>[\s\S]*?<\/encoded\s*>/i.test(source)) {
    return body;
  }
  const decoded = source.replace(
    /<encoded(?:\s[^>]*)?>([\s\S]*?)<\/encoded\s*>/gi,
    (_tag, value) => decryptOpenSslPayload(value.replace(/\s+/g, ""), sessionKey)
  );
  return Buffer.from(decoded, "utf8");
}
class PortalSession {
  /**
   * Create an isolated client with a private cookie jar and session key.
   *
   * @param options Account credentials and optional test/transport controls.
   */
  constructor(options) {
    this.options = options;
    var _a, _b;
    if (typeof options.schoolId !== "string" || !/^\d{1,20}$/.test(options.schoolId) || typeof options.username !== "string" || options.username.length === 0 || options.username.length > MAX_USERNAME_LENGTH || typeof options.password !== "string" || options.password.length === 0 || options.password.length > MAX_PASSWORD_LENGTH) {
      throw new PortalSessionError("invalid-config");
    }
    this.fetchImpl = (_a = options.fetchImpl) != null ? _a : fetch;
    this.now = (_b = options.now) != null ? _b : Date.now;
    this.requestTimeoutMs = validateOption(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS
    );
    this.sessionMaxAgeMs = validateOption(options.sessionMaxAgeMs, DEFAULT_SESSION_MAX_AGE_MS, 24 * 60 * 6e4);
    this.maxResponseBytes = validateOption(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024);
    this.cookies = new PortalCookieJar(this.now);
  }
  cookies;
  messageSourceIds = /* @__PURE__ */ new Map();
  fetchImpl;
  now;
  requestTimeoutMs;
  sessionMaxAgeMs;
  maxResponseBytes;
  sessionKey = null;
  authenticatedAt = null;
  generation = 0;
  authenticationInFlight = null;
  activeControllers = /* @__PURE__ */ new Set();
  closed = false;
  /** Authenticate if no current session exists or the session has expired. */
  async authenticate() {
    await this.authenticateIfNeeded(false);
  }
  /**
   * Make a bounded GET to a start-host path, refreshing an expired session once.
   *
   * @param path Portal-relative path and query for a verified read endpoint.
   */
  async get(path) {
    const target = getReadTarget(path);
    return this.withSessionRetry(() => this.getFollowingRedirects(target));
  }
  /**
   * Make one of the verified form-based data reads; arbitrary POST actions are not exposed.
   *
   * @param request Read-only portal form request.
   */
  async postRead(request) {
    if (request.type === "message-headers") {
      this.messageSourceIds.clear();
    }
    const preparedRequest = request.type === "message-detail" ? void 0 : createReadFormRequest(request, this.sessionKey, this.messageSourceIds);
    if (request.type === "message-detail") {
      const sourceId = this.messageSourceIds.get(request.messageIdHash);
      if (!/^[a-f0-9]{64}$/u.test(request.messageIdHash) || !sourceId || !isSafeMessageSourceId(sourceId)) {
        throw new PortalSessionError("invalid-target");
      }
    }
    try {
      return await this.withSessionRetry(() => {
        const formRequest = preparedRequest != null ? preparedRequest : createReadFormRequest(request, this.sessionKey, this.messageSourceIds);
        return this.postReadOnce(
          formRequest.url,
          formRequest.body,
          formRequest.headers,
          formRequest.decodeMessageHeaders,
          formRequest.messageDetail
        );
      });
    } finally {
      if (request.type === "message-detail") {
        this.messageSourceIds.delete(request.messageIdHash);
      }
    }
  }
  /** Discard transient source IDs retained only to make validated detail reads. */
  discardMessageSourceIds() {
    this.messageSourceIds.clear();
  }
  /** Abort active requests and erase cookies/session key before shutdown. */
  close() {
    var _a;
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.authenticatedAt = null;
    (_a = this.sessionKey) == null ? void 0 : _a.fill(0);
    this.sessionKey = null;
    this.messageSourceIds.clear();
    this.cookies.clear();
    for (const controller of this.activeControllers) {
      controller.abort();
    }
    this.activeControllers.clear();
  }
  async withSessionRetry(send) {
    await this.authenticateIfNeeded(false);
    let observedGeneration = this.generation;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await send();
      if (result.classification !== "session-expired" || attempt === 1) {
        return result;
      }
      await this.authenticateIfNeeded(this.generation === observedGeneration);
      observedGeneration = this.generation;
    }
    return responseResult(401, "session-expired");
  }
  async postReadOnce(url, body, extraHeaders = {}, decodeHeaders = false, messageDetail) {
    return this.withRequest(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
        body
      },
      async (response) => {
        const contentType = response.headers.get("content-type");
        const location = response.headers.get("location");
        if (response.status === 401 || isRedirect(response.status) && isLoginHostRedirect(location != null ? location : "", url)) {
          await cancelBody(response);
          return responseResult(response.status, "session-expired", contentType);
        }
        if (isRedirect(response.status)) {
          await cancelBody(response);
          if (!location) {
            return responseResult(response.status, "redirect", contentType);
          }
          try {
            const redirectTarget = parseAllowedUrl(location, url);
            return responseResult(
              response.status,
              redirectTarget.hostname === START_URL.hostname && isSafeReadTarget(redirectTarget) ? "redirect" : "blocked-redirect",
              contentType
            );
          } catch {
            return responseResult(response.status, "blocked-redirect", contentType);
          }
        }
        if (response.status < 200 || response.status >= 300) {
          await cancelBody(response);
          return responseResult(response.status, classifyPortalStatus(response.status), contentType);
        }
        try {
          const rawBody = await this.readResponseBody(response, this.maxResponseBytes);
          const decodedBody = decodeEncryptedFragments(rawBody, this.sessionKey);
          if (isLoginPage(decodedBody, contentType)) {
            return responseResult(401, "session-expired", contentType);
          }
          let resultBody = decodedBody;
          if (decodeHeaders) {
            const decodedHeaders = decodeMessageHeaderRows(decodedBody, this.sessionKey);
            this.messageSourceIds.clear();
            for (const [hash, sourceId] of decodedHeaders.sourceIds) {
              this.messageSourceIds.set(hash, sourceId);
            }
            resultBody = decodedHeaders.body;
          } else if (messageDetail) {
            resultBody = decodeMessageDetail(decodedBody, this.sessionKey, messageDetail);
          }
          return responseResult(response.status, "success", contentType, resultBody, {
            bodyByteLength: rawBody.byteLength
          });
        } catch (error) {
          if (error instanceof ResponseBodyTooLargeError) {
            return responseResult(response.status, "response-too-large", contentType, void 0, {
              responseSizeDiagnostic: error.diagnostic
            });
          }
          throw error;
        }
      }
    );
  }
  authenticateIfNeeded(force) {
    if (this.closed) {
      return Promise.reject(new PortalSessionError("closed"));
    }
    if (this.authenticationInFlight) {
      return this.authenticationInFlight;
    }
    if (!force && this.isSessionFresh()) {
      return Promise.resolve();
    }
    const authentication = this.performAuthentication();
    this.authenticationInFlight = authentication;
    return authentication.finally(() => {
      if (this.authenticationInFlight === authentication) {
        this.authenticationInFlight = null;
      }
    });
  }
  isSessionFresh() {
    return this.authenticatedAt !== null && this.now() - this.authenticatedAt < this.sessionMaxAgeMs;
  }
  async performAuthentication() {
    var _a;
    if (this.closed) {
      throw new PortalSessionError("closed");
    }
    this.authenticatedAt = null;
    (_a = this.sessionKey) == null ? void 0 : _a.fill(0);
    this.sessionKey = null;
    this.cookies.clear();
    const loginBody = new URLSearchParams({
      user: `${this.options.schoolId}.${this.options.username}`,
      user2: this.options.username,
      password: this.options.password
    }).toString();
    const loginUrl = new URL(LOGIN_URL);
    loginUrl.searchParams.set("i", this.options.schoolId);
    const loginStatus = await this.withRequest(
      loginUrl,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: loginBody
      },
      async (response) => {
        const status = response.status;
        await cancelBody(response);
        return status;
      }
    );
    if (!(loginStatus >= 200 && loginStatus < 300) && !isRedirect(loginStatus)) {
      throw new PortalSessionError("authentication-failed", "login-unexpected-status", loginStatus);
    }
    const connectCookiePresent = this.cookies.header(CONNECT_URL) !== void 0;
    const connectResponse = await this.withRequest(CONNECT_URL, { method: "HEAD" }, async (response) => {
      const location = response.headers.get("location");
      const status = response.status;
      await cancelBody(response);
      if (status === 401 || status === 403) {
        throw new PortalSessionError("authentication-failed", "connect-auth-rejected", status);
      }
      if (!isRedirect(status) || !location) {
        throw new PortalSessionError("authentication-failed", "connect-invalid-response", status);
      }
      return { location, status };
    });
    let authTarget;
    try {
      authTarget = parseAllowedUrl(connectResponse.location, CONNECT_URL);
    } catch {
      throw new PortalSessionError("authentication-failed", "connect-redirect-invalid", connectResponse.status);
    }
    if (authTarget.hostname === LOGIN_URL.hostname) {
      const diagnostic = connectCookiePresent ? "connect-session-missing-cookie-sent" : "connect-session-missing-no-cookie";
      throw new PortalSessionError("authentication-failed", diagnostic, connectResponse.status);
    }
    if (authTarget.hostname !== START_URL.hostname) {
      throw new PortalSessionError("authentication-failed", "connect-host-rejected", connectResponse.status);
    }
    await this.getAuthenticationTarget(authTarget);
    await this.performRsaHandshake();
    if (this.closed) {
      throw new PortalSessionError("closed");
    }
    this.authenticatedAt = this.now();
    this.generation++;
  }
  async getAuthenticationTarget(initialTarget) {
    let target = initialTarget;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const result = await this.withRequest(target, { method: "GET" }, async (response) => {
        const location = response.headers.get("location");
        const status = response.status;
        if (status === 401 || status === 403) {
          await cancelBody(response);
          throw new PortalSessionError("authentication-failed", "start-auth-rejected", status);
        }
        if (isRedirect(status) && isLoginHostRedirect(location != null ? location : "", target)) {
          await cancelBody(response);
          throw new PortalSessionError("authentication-failed", "start-login-redirect", status);
        }
        if (isRedirect(status)) {
          await cancelBody(response);
          if (!location || redirects === MAX_REDIRECTS) {
            throw new PortalSessionError("authentication-failed", "start-redirect-incomplete", status);
          }
          let next;
          try {
            next = parseAllowedUrl(location, target);
          } catch {
            throw new PortalSessionError("authentication-failed", "start-redirect-invalid", status);
          }
          if (next.hostname !== START_URL.hostname) {
            throw new PortalSessionError("authentication-failed", "start-host-rejected", status);
          }
          return next;
        }
        await cancelBody(response);
        if (status < 200 || status >= 300) {
          throw new PortalSessionError("authentication-failed", "start-unexpected-status", status);
        }
        return null;
      });
      if (result === null) {
        return;
      }
      target = result;
    }
    throw new PortalSessionError("authentication-failed");
  }
  async performRsaHandshake() {
    var _a;
    const publicKeyResponse = await this.withRequest(
      new URL("/ajax.php?f=rsaPublicKey", START_URL),
      { method: "POST" },
      (response) => this.readJsonObject(response, MAX_AUTH_RESPONSE_BYTES, "rsa-public-key")
    );
    let publicKey;
    let sessionKey;
    let encryptedKey;
    try {
      if (typeof publicKeyResponse.publickey !== "string") {
        throw new Error();
      }
      publicKey = (0, import_node_crypto.createPublicKey)(publicKeyResponse.publickey);
      sessionKey = (0, import_node_crypto.randomBytes)(SESSION_KEY_BYTES);
      encryptedKey = (0, import_node_crypto.publicEncrypt)({ key: publicKey, padding: import_node_crypto.constants.RSA_PKCS1_PADDING }, sessionKey);
    } catch {
      sessionKey == null ? void 0 : sessionKey.fill(0);
      throw new PortalSessionError("handshake-failed", "rsa-public-key-invalid");
    }
    if (!sessionKey) {
      throw new PortalSessionError("handshake-failed", "rsa-public-key-invalid");
    }
    const handshakeUrl = new URL("/ajax.php", START_URL);
    handshakeUrl.searchParams.set("f", "rsaHandshake");
    handshakeUrl.searchParams.set("s", String((0, import_node_crypto.randomInt)(2e3)));
    const handshakeBody = new URLSearchParams({ key: encryptedKey.toString("base64") }).toString();
    let keyRetained = false;
    try {
      const challengeResponse = await this.withRequest(
        handshakeUrl,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: handshakeBody
        },
        (response) => this.readJsonObject(response, MAX_AUTH_RESPONSE_BYTES, "rsa-handshake")
      );
      if (this.closed) {
        throw new PortalSessionError("closed");
      }
      if (!verifyChallenge(challengeResponse.challenge, sessionKey)) {
        throw new PortalSessionError("handshake-failed", "rsa-handshake-invalid");
      }
      (_a = this.sessionKey) == null ? void 0 : _a.fill(0);
      this.sessionKey = sessionKey;
      keyRetained = true;
    } finally {
      if (!keyRetained) {
        sessionKey.fill(0);
      }
    }
  }
  async readJsonObject(response, limit, phase) {
    const responseDiagnostic = phase === "rsa-public-key" ? "rsa-public-key-response-invalid" : "rsa-handshake-response-invalid";
    if (response.status < 200 || response.status >= 300) {
      const status = response.status;
      await cancelBody(response);
      throw new PortalSessionError("handshake-failed", responseDiagnostic, status);
    }
    let body;
    try {
      body = await this.readResponseBody(response, limit);
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new PortalSessionError("handshake-failed", responseDiagnostic, response.status);
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error();
      }
      return parsed;
    } catch {
      throw new PortalSessionError("handshake-failed", responseDiagnostic, response.status);
    }
  }
  async getFollowingRedirects(initialTarget) {
    let target = initialTarget;
    for (let redirects = 0; ; redirects++) {
      const next = await this.withRequest(target, { method: "GET" }, async (response) => {
        const contentType = response.headers.get("content-type");
        const location = response.headers.get("location");
        if (response.status === 401 || isRedirect(response.status) && isLoginHostRedirect(location != null ? location : "", target)) {
          await cancelBody(response);
          return { response: responseResult(response.status, "session-expired", contentType), target: null };
        }
        if (isRedirect(response.status)) {
          if (!location) {
            await cancelBody(response);
            return { response: responseResult(response.status, "redirect", contentType), target: null };
          }
          let redirectTarget;
          try {
            redirectTarget = parseAllowedUrl(location, target);
          } catch {
            await cancelBody(response);
            return {
              response: responseResult(response.status, "blocked-redirect", contentType),
              target: null
            };
          }
          if (redirectTarget.hostname === LOGIN_URL.hostname || redirectTarget.hostname === CONNECT_URL.hostname) {
            await cancelBody(response);
            return {
              response: responseResult(response.status, "session-expired", contentType),
              target: null
            };
          }
          if (redirectTarget.hostname !== START_URL.hostname || !isSafeReadTarget(redirectTarget)) {
            await cancelBody(response);
            return {
              response: responseResult(response.status, "blocked-redirect", contentType),
              target: null
            };
          }
          if (redirects >= MAX_REDIRECTS) {
            await cancelBody(response);
            return {
              response: responseResult(response.status, "redirect-limit", contentType),
              target: null
            };
          }
          await cancelBody(response);
          return { response: null, target: redirectTarget };
        }
        if (response.status < 200 || response.status >= 300) {
          await cancelBody(response);
          return {
            response: responseResult(response.status, classifyPortalStatus(response.status), contentType),
            target: null
          };
        }
        try {
          const rawBody = await this.readResponseBody(response, this.maxResponseBytes);
          const body = decodeEncryptedFragments(rawBody, this.sessionKey);
          if (isLoginPage(body, contentType)) {
            return {
              response: responseResult(401, "session-expired", contentType),
              target: null
            };
          }
          return {
            response: responseResult(response.status, "success", contentType, body, {
              bodyByteLength: rawBody.byteLength
            }),
            target: null
          };
        } catch (error) {
          if (error instanceof ResponseBodyTooLargeError) {
            return {
              response: responseResult(response.status, "response-too-large", contentType, void 0, {
                responseSizeDiagnostic: error.diagnostic
              }),
              target: null
            };
          }
          throw error;
        }
      });
      if (next.response) {
        return next.response;
      }
      if (next.target) {
        target = next.target;
      }
    }
  }
  async readResponseBody(response, limit) {
    const contentLengthHeader = response.headers.get("content-length");
    const contentLength = Number(contentLengthHeader);
    const declaredContentLength = getSafeContentLength(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      await cancelBody(response);
      throw new ResponseBodyTooLargeError(limit, declaredContentLength, false);
    }
    if (!response.body) {
      return new Uint8Array();
    }
    const reader = response.body.getReader();
    const prefix = contentLengthHeader === null ? Buffer.alloc(MAX_RESPONSE_PREFIX_BYTES) : void 0;
    const chunks = [];
    let prefixLength = 0;
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (prefix && prefixLength < prefix.length) {
          const prefixChunkLength = Math.min(value.byteLength, prefix.length - prefixLength);
          prefix.set(value.subarray(0, prefixChunkLength), prefixLength);
          prefixLength += prefixChunkLength;
        }
        total += value.byteLength;
        if (total > limit) {
          const prefixClassification = prefix ? classifyResponsePrefix(prefix.subarray(0, prefixLength)) : "not-inspected";
          prefix == null ? void 0 : prefix.fill(0);
          await reader.cancel();
          throw new ResponseBodyTooLargeError(limit, declaredContentLength, true, prefixClassification);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      prefix == null ? void 0 : prefix.fill(0);
      reader.releaseLock();
    }
    return Buffer.concat(chunks, total);
  }
  async withRequest(url, init, consume) {
    if (this.closed) {
      throw new PortalSessionError("closed");
    }
    const safeUrl = parseAllowedUrl(url);
    const headers = new Headers(init.headers);
    headers.set("user-agent", ADAPTER_USER_AGENT);
    const cookieHeader = this.cookies.header(safeUrl);
    if (safeUrl.hostname === START_URL.hostname && this.authenticatedAt !== null) {
      const schoolContextCookieNames = /* @__PURE__ */ new Set(["sph-login-upstream", "schulportal_lastschool", "i"]);
      const cookies = (cookieHeader != null ? cookieHeader : "").split(";").map((cookie) => cookie.trim()).filter((cookie) => cookie && !schoolContextCookieNames.has(cookie.split("=", 1)[0]));
      cookies.push(
        "sph-login-upstream=4",
        `schulportal_lastschool=${this.options.schoolId}`,
        `i=${this.options.schoolId}`
      );
      headers.set("cookie", cookies.join("; "));
    } else if (cookieHeader) {
      headers.set("cookie", cookieHeader);
    }
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let timedOut = false;
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new PortalSessionError("timeout"));
      }, this.requestTimeoutMs);
    });
    const operation = (async () => {
      const response = await this.fetchImpl(safeUrl, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal
      });
      if (this.closed) {
        await cancelBody(response);
        throw new PortalSessionError("closed");
      }
      this.cookies.store(safeUrl, response.headers);
      return consume(response);
    })();
    try {
      return await Promise.race([operation, timeout]);
    } catch (error) {
      if (error instanceof PortalSessionError) {
        throw error;
      }
      throw new PortalSessionError(this.closed ? "closed" : timedOut ? "timeout" : "network-error");
    } finally {
      if (timer !== void 0) {
        clearTimeout(timer);
      }
      this.activeControllers.delete(controller);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  PortalSession,
  PortalSessionError,
  classifyPortalStatus
});
//# sourceMappingURL=portal-session.js.map
