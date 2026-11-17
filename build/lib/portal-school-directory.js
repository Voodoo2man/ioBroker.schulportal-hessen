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
var portal_school_directory_exports = {};
__export(portal_school_directory_exports, {
  SchoolDirectoryError: () => SchoolDirectoryError,
  fetchSchoolOptions: () => fetchSchoolOptions,
  parseSchoolDirectory: () => parseSchoolDirectory,
  searchSchoolOptions: () => searchSchoolOptions
});
module.exports = __toCommonJS(portal_school_directory_exports);
const SCHOOL_DIRECTORY_URL = new URL("https://startcache.schulportal.hessen.de/exporteur.php?a=schoollist");
const REQUEST_TIMEOUT_MS = 1e4;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCHOOL_COUNT = 1e4;
const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 100;
const MAX_SEARCH_RESULTS = 50;
class SchoolDirectoryError extends Error {
  /** Create a generic directory error without transport details. */
  constructor() {
    super("The public school directory could not be loaded.");
    this.name = "SchoolDirectoryError";
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function cleanLabelPart(value) {
  return typeof value === "string" ? value.replace(new RegExp("\\p{Cc}", "gu"), " ").replace(/\s+/g, " ").trim() : "";
}
function schoolId(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    value = String(value);
  }
  return typeof value === "string" && /^\d{1,20}$/.test(value) ? value : void 0;
}
function parseSchoolDirectory(payload) {
  if (!Array.isArray(payload) || payload.length > 100) {
    throw new SchoolDirectoryError();
  }
  const schools = /* @__PURE__ */ new Map();
  for (const district of payload) {
    if (!isRecord(district) || !Array.isArray(district.Schulen)) {
      throw new SchoolDirectoryError();
    }
    for (const school of district.Schulen) {
      if (!isRecord(school)) {
        throw new SchoolDirectoryError();
      }
      const id = schoolId(school.Id);
      const name = cleanLabelPart(school.Name);
      const town = cleanLabelPart(school.Ort);
      if (!id || !name) {
        continue;
      }
      if (!schools.has(id)) {
        schools.set(id, `${name}${town ? ` \u2014 ${town}` : ""} (${id})`);
      }
      if (schools.size > MAX_SCHOOL_COUNT) {
        throw new SchoolDirectoryError();
      }
    }
  }
  return [...schools].map(([value, label]) => ({ value, label }));
}
function normalizeSearchText(value) {
  return value.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLocaleLowerCase("de").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ").trim();
}
function searchSchoolOptions(options, query) {
  if (typeof query !== "string" || query.length > MAX_SEARCH_LENGTH) {
    return [];
  }
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length < MIN_SEARCH_LENGTH) {
    return [];
  }
  const terms = normalizedQuery.split(/\s+/);
  return options.map((option, index) => {
    const label = normalizeSearchText(option.label);
    if (!terms.every((term) => label.includes(term))) {
      return void 0;
    }
    const score = option.value === normalizedQuery ? 2 : label.startsWith(normalizedQuery) ? 1 : 0;
    return { option, index, score };
  }).filter((item) => item !== void 0).sort((left, right) => right.score - left.score || left.index - right.index).slice(0, MAX_SEARCH_RESULTS).map((item) => item.option);
}
async function readBoundedBody(response) {
  var _a;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await ((_a = response.body) == null ? void 0 : _a.cancel());
    throw new SchoolDirectoryError();
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new SchoolDirectoryError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
async function fetchSchoolOptions(fetchImpl = fetch) {
  var _a;
  try {
    const response = await fetchImpl(SCHOOL_DIRECTORY_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
      await ((_a = response.body) == null ? void 0 : _a.cancel());
      throw new SchoolDirectoryError();
    }
    const payload = JSON.parse(Buffer.from(await readBoundedBody(response)).toString("utf8"));
    return parseSchoolDirectory(payload);
  } catch (error) {
    if (error instanceof SchoolDirectoryError) {
      throw error;
    }
    throw new SchoolDirectoryError();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SchoolDirectoryError,
  fetchSchoolOptions,
  parseSchoolDirectory,
  searchSchoolOptions
});
//# sourceMappingURL=portal-school-directory.js.map
