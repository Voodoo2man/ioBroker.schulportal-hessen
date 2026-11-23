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
var portal_parser_exports = {};
__export(portal_parser_exports, {
  MAX_SUBSTITUTION_DATES: () => MAX_SUBSTITUTION_DATES,
  TIMETABLE_WEEKDAY_IDS: () => TIMETABLE_WEEKDAY_IDS,
  canonicalCalendarDateField: () => canonicalCalendarDateField,
  canonicalPortalColumn: () => canonicalPortalColumn,
  canonicalPortalSection: () => canonicalPortalSection,
  getProfileFieldDisplayName: () => getProfileFieldDisplayName,
  getProfileFieldId: () => getProfileFieldId,
  getProfileSummaryField: () => getProfileSummaryField,
  isTimetableDateHeader: () => isTimetableDateHeader,
  normalizePortalHeader: () => normalizePortalHeader,
  normalizePortalLabel: () => normalizePortalLabel,
  normalizeTimetableWeekday: () => normalizeTimetableWeekday,
  parsePortalResource: () => parsePortalResource,
  parsePortalTimetableChildDetail: () => parsePortalTimetableChildDetail
});
module.exports = __toCommonJS(portal_parser_exports);
var import_node_crypto = require("node:crypto");
var import_node_html_parser = require("node-html-parser");
const TIMETABLE_SECTION_IDS = ["all", "own"];
const LESSON_SECTION_IDS = ["mappen", "history", "attendanceTable", "marks", "klausuren"];
const SUBSTITUTION_HEADERS = ["", "Stunde", "Klasse", "Vertretung", "Lehrkraft", "Fach", "Raum", "Hinweis"];
const MAX_PARENT_CHILD_TABS = 20;
const CHILD_LESSON_SECTION_ORDER = [
  "current",
  "assignments",
  "attendance",
  "other"
];
const MAX_SUBSTITUTION_DATES = 31;
const RESOURCE_KINDS = [
  "account",
  "messages",
  "timetable",
  "substitutions",
  "substitution-dates",
  "calendar",
  "school-calendar",
  "lessons",
  "learning-groups",
  "file-metadata"
];
function parsePortalResource(kind, body, contentType) {
  return parsePortalResourceInternal(kind, body, contentType, false);
}
function parsePortalTimetableChildDetail(body, contentType) {
  return parsePortalResourceInternal("timetable", body, contentType, true);
}
function parsePortalResourceInternal(kind, body, contentType, recoverMalformedTimetableDetail) {
  if (!RESOURCE_KINDS.includes(kind) || typeof body !== "string") {
    return { status: "invalid", kind, reason: "invalid-input" };
  }
  const source = body.replace(/^\uFEFF/u, "");
  if (!source.trim()) {
    return { status: "invalid", kind, reason: "empty-response" };
  }
  const format = getFormat(kind, source, contentType);
  if (!format) {
    return { status: "invalid", kind, reason: "unsupported-content-type" };
  }
  if (format === "json") {
    return kind === "school-calendar" ? { status: "invalid", kind, reason: "unsupported-content-type" } : parseJsonRecords(kind, source);
  }
  if (format === "csv") {
    return kind === "school-calendar" ? parseSchoolCalendarCsv(source) : { status: "invalid", kind, reason: "unsupported-content-type" };
  }
  if (format === "ical") {
    return kind === "school-calendar" ? parseSchoolCalendarIcal(source) : { status: "invalid", kind, reason: "unsupported-content-type" };
  }
  return parseHtmlRecords(kind, source, recoverMalformedTimetableDetail);
}
function getFormat(kind, body, contentType) {
  const mimeType = contentType == null ? void 0 : contentType.split(";", 1)[0].trim().toLowerCase();
  if (mimeType == null ? void 0 : mimeType.includes("json")) {
    return "json";
  }
  if ((mimeType == null ? void 0 : mimeType.includes("html")) || (mimeType == null ? void 0 : mimeType.includes("xhtml"))) {
    return "html";
  }
  if (mimeType == null ? void 0 : mimeType.includes("csv")) {
    return "csv";
  }
  if (mimeType && /(?:^|\/)(?:calendar|icalendar|x-vcalendar|ics)$/u.test(mimeType)) {
    return "ical";
  }
  const trimmed = body.trimStart();
  if (/^BEGIN:VCALENDAR(?:\r?\n|$)/iu.test(trimmed)) {
    return "ical";
  }
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    return "json";
  }
  if (first === "<") {
    return "html";
  }
  return kind === "school-calendar" && (trimmed.includes(",") || trimmed.includes(";")) ? "csv" : null;
}
function parseJsonRecords(kind, body) {
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return { status: "invalid", kind, reason: "malformed-json" };
  }
  if (!Array.isArray(value)) {
    return { status: "unavailable", kind, reason: "unrecognized-json-structure" };
  }
  if (value.length === 0) {
    return kind === "calendar" || kind === "substitutions" || kind === "messages" ? { status: "complete", kind, records: [], groups: [] } : { status: "unavailable", kind, reason: "unrecognized-json-structure" };
  }
  if (!value.every(isRecord)) {
    return { status: "invalid", kind, reason: "invalid-json-records" };
  }
  const records = value.map((sourceFields) => {
    const fields = kind === "messages" ? sanitizeMessageFields(sourceFields) : sanitizeJsonFields(sourceFields, kind === "file-metadata");
    return {
      format: "json",
      id: getJsonId(fields),
      fields
    };
  });
  if (hasDuplicateRecordIds(records)) {
    return { status: "invalid", kind, reason: "invalid-json-records" };
  }
  return { status: "complete", kind, records, groups: [] };
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const MESSAGE_METADATA_FIELDS = /* @__PURE__ */ new Set(["id", "subject", "sendershortname", "sendername", "date", "unread", "hidden"]);
function sanitizeMessageFields(fields) {
  const metadata = Object.fromEntries(
    Object.entries(fields).filter(([name]) => MESSAGE_METADATA_FIELDS.has(normalizeRecordKey(name)))
  );
  const safe = sanitizeJsonFields(metadata);
  if (typeof fields.username === "string") {
    const username = sanitizeMessageText(fields.username);
    if (username !== null) {
      safe.username = username;
    }
  }
  if (typeof fields.own === "boolean") {
    safe.own = fields.own;
  }
  if (typeof fields.content === "string") {
    const content = sanitizeMessageText(fields.content);
    if (content !== null) {
      safe.content = content;
    }
  }
  if (Number.isSafeInteger(fields.time) && fields.time >= 0) {
    safe.time = fields.time;
  }
  for (const name of ["groupChat", "onlyPrivateAnswers", "noReply"]) {
    if (typeof fields[name] === "boolean") {
      safe[name] = fields[name];
    }
  }
  const participantCounts = fields.participantCounts;
  if (isRecord(participantCounts)) {
    const counts = ["students", "teachers", "parents"];
    if (counts.every(
      (name) => typeof participantCounts[name] === "number" && Number.isSafeInteger(participantCounts[name]) && participantCounts[name] >= 0
    )) {
      safe.participantCounts = Object.fromEntries(counts.map((name) => [name, participantCounts[name]]));
    }
  }
  if (Array.isArray(fields.replies) && fields.replies.length <= 100) {
    const replies = fields.replies.map(sanitizeMessageReply);
    if (replies.every((reply) => reply !== null)) {
      safe.replies = replies;
    }
  }
  return safe;
}
function sanitizeMessageReply(value) {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[a-f0-9]{64}$/u.test(value.id) || typeof value.date !== "string" || value.date.length > 8192 || hasControlCharacters(value.date) || typeof value.username !== "string" || typeof value.own !== "boolean" || typeof value.content !== "string") {
    return null;
  }
  const username = sanitizeMessageText(value.username);
  const content = sanitizeMessageText(value.content);
  if (username === null || content === null) {
    return null;
  }
  return { id: value.id, date: value.date, username, own: value.own, content };
}
function hasUnsafeMessageTextControls(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== void 0 && (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13 || codePoint >= 127 && codePoint <= 159);
  });
}
function sanitizeMessageText(value) {
  if (value.length > 4 * 1024 * 1024 || hasUnsafeMessageTextControls(value)) {
    return null;
  }
  try {
    const toText = (html) => {
      const root = (0, import_node_html_parser.parse)(html);
      for (const unsafe of root.querySelectorAll("script, style, iframe, object, embed")) {
        unsafe.remove();
      }
      for (const hidden of root.querySelectorAll('[hidden], [aria-hidden="true"], .hidden, .hidden_encoded')) {
        hidden.remove();
      }
      return root.text;
    };
    let text = toText(value);
    if (/<\/?[a-z][^>]*>/iu.test(text)) {
      text = toText(text);
    }
    return text.replace(/\r\n?/gu, "\n").trim();
  } catch {
    return null;
  }
}
const OMIT_JSON_VALUE = Symbol("omit-json-value");
function sanitizeJsonFields(fields, omitUrls = false) {
  const safe = [];
  for (const [name, value] of Object.entries(fields)) {
    const normalizedName = name.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`).toLowerCase();
    if (/(?:session|sess(?:ion)?id|sid|token|cookie|csrf|auth|secret|password|credential|ticket)/iu.test(name) || /(?:html|markup)/iu.test(name) || normalizedName === "id" && typeof value === "string" && !isSafeExplicitId(value)) {
      continue;
    }
    const isUrlField = /(?:^|_)(?:href|url|uri|link|src|path)$/u.test(normalizedName);
    if (omitUrls && isUrlField) {
      continue;
    }
    const sanitized = sanitizeJsonValue(value, isUrlField, omitUrls);
    if (sanitized !== OMIT_JSON_VALUE) {
      safe.push([name, sanitized]);
    }
  }
  return Object.fromEntries(safe);
}
function sanitizeJsonValue(value, isUrlField = false, omitUrls = false) {
  var _a;
  if (typeof value === "string") {
    if (/<\/?[a-z][^>]*>/iu.test(value)) {
      return OMIT_JSON_VALUE;
    }
    if (isUrlField || looksLikeUrl(value)) {
      return omitUrls ? OMIT_JSON_VALUE : (_a = safeRelativePath(value)) != null ? _a : OMIT_JSON_VALUE;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, false, omitUrls)).filter((item) => item !== OMIT_JSON_VALUE);
  }
  if (isRecord(value)) {
    return sanitizeJsonFields(value, omitUrls);
  }
  return value;
}
function looksLikeUrl(value) {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || /^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith("?") && value.length > 1 || /^[^ ]+\?[^ ]*=/u.test(value);
}
function hasDuplicateRecordIds(records) {
  const seen = /* @__PURE__ */ new Set();
  for (const record of records) {
    if (seen.has(record.id)) {
      return true;
    }
    seen.add(record.id);
  }
  return false;
}
function getJsonId(fields) {
  var _a;
  const idNames = ["uid", "fremuid", "fremduid", "id", "eventid"];
  for (const idName of idNames) {
    const sourceId = (_a = Object.entries(fields).find(([name]) => normalizeRecordKey(name) === idName)) == null ? void 0 : _a[1];
    if (typeof sourceId === "string" && isSafeExplicitId(sourceId) || typeof sourceId === "number") {
      return hashSourceId(String(sourceId));
    }
  }
  return hashId(canonicalJson(fields));
}
function normalizeRecordKey(value) {
  return value.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").replace(/ß/gu, "ss").toLowerCase().replace(/[^a-z0-9]/gu, "");
}
function canonicalPortalSection(section) {
  switch (section) {
    case "LGs":
      return "learningGroups";
    case "klausuren":
      return "exams";
    case "mappen":
      return "assignments";
    case "attendanceTable":
    case "anwesend":
      return "attendance";
    case "aktuell":
      return "current";
    default:
      return section;
  }
}
function normalizePortalLabel(label) {
  return label.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US").replace(/ß/gu, "ss");
}
function normalizePortalHeader(header) {
  return normalizePortalLabel(header).replace(/[^a-z0-9]+/gu, " ").trim();
}
const PORTAL_COLUMN_ALIASES = /* @__PURE__ */ new Map([
  ["stunde", "period"],
  ["klasse", "class"],
  ["vertretung", "substitution"],
  ["lehrkraft", "teacher"],
  ["fach", "subject"],
  ["raum", "room"],
  ["hinweis", "note"],
  ["datum", "date"],
  ["wochentag", "weekday"],
  ["tag", "day"],
  ["kurs", "course"],
  ["weiteres", "additional information"],
  ["anwesend", "present"],
  ["entschuldigt", "excused"],
  ["andere schulische veranstaltung", "other school event"],
  ["thema datum inhalt wenn hinterlegt hausaufgaben wenn hinterlegt", "lesson details"]
]);
function canonicalPortalColumn(header) {
  var _a;
  const normalized = header.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase().replace(/ß/gu, "ss").replace(/[^a-z0-9]+/gu, " ").trim();
  return (_a = PORTAL_COLUMN_ALIASES.get(normalized)) != null ? _a : normalized;
}
const PROFILE_FIELD_DISPLAY_NAMES = /* @__PURE__ */ new Map([
  ["name", "Name"],
  ["full name", "Full name"],
  ["display name", "Display name"],
  ["school", "School"],
  ["schule", "School"]
]);
function getProfileFieldDisplayName(label) {
  var _a;
  return (_a = PROFILE_FIELD_DISPLAY_NAMES.get(normalizePortalHeader(label))) != null ? _a : null;
}
function getProfileSummaryField(label) {
  switch (normalizeRecordKey(label)) {
    case "name":
    case "fullname":
      return "name";
    case "school":
    case "schule":
      return "school";
    default:
      return null;
  }
}
const TIMETABLE_WEEKDAYS = [
  { id: "monday", names: ["monday", "mon", "montag", "mo"] },
  { id: "tuesday", names: ["tuesday", "tue", "tues", "dienstag", "di"] },
  { id: "wednesday", names: ["wednesday", "wed", "mittwoch", "mi"] },
  { id: "thursday", names: ["thursday", "thu", "thur", "thurs", "donnerstag", "do"] },
  { id: "friday", names: ["friday", "fri", "freitag", "fr"] },
  { id: "saturday", names: ["saturday", "sat", "samstag", "sa"] },
  { id: "sunday", names: ["sunday", "sun", "sonntag", "so"] }
];
const TIMETABLE_WEEKDAY_IDS = TIMETABLE_WEEKDAYS.map(({ id }) => id);
function isTimetableDateHeader(header) {
  const label = normalizePortalLabel(header);
  return /date|datum|weekday|wochentag/u.test(label) || /(^|[^a-z])(day|tag)([^a-z]|$)/u.test(label);
}
function normalizeTimetableWeekday(value) {
  var _a, _b, _c;
  const token = (_a = normalizePortalLabel(value.trim()).match(/^[a-z]+/u)) == null ? void 0 : _a[0];
  return (_c = (_b = TIMETABLE_WEEKDAYS.find((day) => day.names.includes(token != null ? token : ""))) == null ? void 0 : _b.id) != null ? _c : null;
}
function getProfileFieldId(label, occurrences) {
  var _a;
  const normalizedLabel = label.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const occurrence = ((_a = occurrences.get(normalizedLabel)) != null ? _a : 0) + 1;
  occurrences.set(normalizedLabel, occurrence);
  return hashId({ recordType: "profile", label: normalizedLabel, occurrence });
}
function hashSourceId(sourceId) {
  return `source:${(0, import_node_crypto.createHash)("sha256").update(sourceId).digest("hex")}`;
}
function canonicalJson(value) {
  var _a;
  if (typeof value === "string") {
    return JSON.stringify(normalizeText(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return (_a = JSON.stringify(value)) != null ? _a : "null";
}
function canonicalCalendarDateField(key) {
  switch (normalizeRecordKey(key)) {
    case "start":
    case "startsat":
    case "anfang":
      return "start";
    case "end":
    case "endsat":
    case "ende":
      return "end";
    default:
      return null;
  }
}
const SCHOOL_CALENDAR_HEADER_ALIASES = {
  start: ["start", "begin", "beginning", "startdate", "startdatetime", "anfang", "from"],
  end: ["end", "until", "enddate", "enddatetime", "ende", "to"],
  all_day: ["allday", "isallday", "fullday", "ganztag", "ganztags", "ganztaegig", "ganztagig"],
  summary: ["summary", "title", "titel", "subject", "betreff", "name"],
  description: ["description", "beschreibung", "details", "detail"],
  location: ["location", "place", "ort", "room", "raum"],
  category: ["category", "categories", "art", "kategorie", "type", "typ"],
  responsible: ["responsible", "organizer", "organiser", "verantwortlich", "owner"],
  uid: ["uid", "id", "eventid", "eventuid", "fremuid"]
};
function parseSchoolCalendarCsv(body) {
  const candidates = [parseCsvRows(body, ","), parseCsvRows(body, ";")].filter(
    (rows2) => rows2 !== null && rows2.length > 0
  );
  const rows = candidates.sort((left, right) => calendarHeaderScore(right[0]) - calendarHeaderScore(left[0]))[0];
  if (!rows) {
    return { status: "invalid", kind: "school-calendar", reason: "malformed-csv" };
  }
  const headers = rows[0].map(calendarFieldForHeader);
  const recognizedHeaders = headers.filter((header) => header !== null);
  if (!headers.includes("start") || !headers.includes("end") || new Set(recognizedHeaders).size !== recognizedHeaders.length) {
    return { status: "invalid", kind: "school-calendar", reason: "unexpected-calendar-structure" };
  }
  const records = [];
  for (const row of rows.slice(1)) {
    if (row.length !== headers.length) {
      return { status: "invalid", kind: "school-calendar", reason: "invalid-csv-records" };
    }
    const sourceFields = {};
    for (const [index, header] of headers.entries()) {
      if (!header) {
        continue;
      }
      const value = row[index];
      sourceFields[header] = header === "all_day" ? parseAllDayValue(value) : value;
    }
    const fields = sanitizeJsonFields(sourceFields);
    records.push({ format: "json", id: getJsonId(fields), fields });
  }
  if (hasDuplicateRecordIds(records)) {
    return { status: "invalid", kind: "school-calendar", reason: "invalid-csv-records" };
  }
  return { status: "complete", kind: "school-calendar", records, groups: [] };
}
function parseCsvRows(body, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false;
  const finishField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (row.length > 1 || row.some((value) => value.length > 0)) {
      rows.push(row);
    }
    row = [];
  };
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    if (inQuotes) {
      if (character === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote && character !== delimiter && character !== "\r" && character !== "\n" && !/[ \t]/u.test(character)) {
      return null;
    }
    if (character === delimiter) {
      finishField();
    } else if (character === "\r" || character === "\n") {
      finishRow();
      if (character === "\r" && body[index + 1] === "\n") {
        index++;
      }
    } else if (character === '"') {
      if (field.length > 0 || afterQuote) {
        return null;
      }
      inQuotes = true;
    } else if (!afterQuote) {
      field += character;
    }
  }
  if (inQuotes) {
    return null;
  }
  if (field.length > 0 || row.length > 0 || afterQuote) {
    finishRow();
  }
  return rows;
}
function calendarHeaderScore(headers) {
  return headers.filter((header) => calendarFieldForHeader(header) !== null).length;
}
function calendarFieldForHeader(header) {
  var _a, _b;
  const normalized = normalizeRecordKey(header.trim());
  return (_b = (_a = Object.entries(SCHOOL_CALENDAR_HEADER_ALIASES).find(
    ([, aliases]) => aliases.includes(normalized)
  )) == null ? void 0 : _a[0]) != null ? _b : null;
}
function parseAllDayValue(value) {
  const normalized = normalizeRecordKey(value.trim());
  if (["1", "true", "yes", "ja", "y", "ganztag", "ganztags"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "nein", "n"].includes(normalized)) {
    return false;
  }
  return value;
}
function parseSchoolCalendarIcal(body) {
  const lines = unfoldIcalLines(body);
  if (!lines || lines.length === 0) {
    return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
  }
  const components = [];
  const records = [];
  let calendarStarted = false;
  let calendarEnded = false;
  let eventProperties = null;
  for (const line of lines) {
    if (!line) {
      return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
    }
    const property = parseIcalProperty(line);
    if (!property) {
      return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
    }
    if (property.name === "BEGIN") {
      const component = property.value.toUpperCase();
      if (!/^[A-Z0-9-]+$/u.test(component) || calendarEnded) {
        return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
      }
      if (components.length === 0) {
        if (calendarStarted || component !== "VCALENDAR") {
          return { status: "invalid", kind: "school-calendar", reason: "unexpected-calendar-structure" };
        }
        calendarStarted = true;
      } else if (components[0] !== "VCALENDAR" || component === "VCALENDAR") {
        return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
      }
      if (component === "VEVENT" && (components.length !== 1 || components[0] !== "VCALENDAR")) {
        return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
      }
      components.push(component);
      if (component === "VEVENT") {
        eventProperties = [];
      }
      continue;
    }
    if (property.name === "END") {
      const component = property.value.toUpperCase();
      if (components.at(-1) !== component) {
        return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
      }
      if (component === "VEVENT") {
        const record = createIcalEventRecord(eventProperties != null ? eventProperties : []);
        if (!record) {
          return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
        }
        records.push(record);
        eventProperties = null;
      }
      components.pop();
      if (component === "VCALENDAR") {
        calendarEnded = true;
      }
      continue;
    }
    if (components.length === 0 || calendarEnded) {
      return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
    }
    if (components.at(-1) === "VEVENT" && components.length === 2) {
      eventProperties == null ? void 0 : eventProperties.push(property);
    }
  }
  if (!calendarStarted || !calendarEnded || components.length > 0) {
    return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
  }
  if (hasDuplicateRecordIds(records)) {
    return { status: "invalid", kind: "school-calendar", reason: "malformed-icalendar" };
  }
  return { status: "complete", kind: "school-calendar", records, groups: [] };
}
function unfoldIcalLines(body) {
  const physicalLines = body.split(/\r\n|\n|\r/u);
  while (physicalLines.at(-1) === "") {
    physicalLines.pop();
  }
  const lines = [];
  for (const line of physicalLines) {
    if (line.startsWith(" ") || line.startsWith("	")) {
      if (lines.length === 0) {
        return null;
      }
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}
function parseIcalProperty(line) {
  var _a;
  const separator = findIcalValueSeparator(line);
  if (separator <= 0) {
    return null;
  }
  const headerParts = splitIcalHeader(line.slice(0, separator));
  if (!headerParts || headerParts.length === 0) {
    return null;
  }
  const rawName = (_a = headerParts[0].split(".").at(-1)) != null ? _a : "";
  if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(rawName)) {
    return null;
  }
  const params = [];
  for (const parameter of headerParts.slice(1)) {
    const equals = parameter.indexOf("=");
    if (equals <= 0) {
      return null;
    }
    const name = parameter.slice(0, equals).trim().toUpperCase();
    let value = parameter.slice(equals + 1).trim();
    if (!/^[A-Z0-9-]+$/u.test(name)) {
      return null;
    }
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) {
        return null;
      }
      value = value.slice(1, -1).replace(/\^n/giu, "\n").replace(/\^'/gu, '"').replace(/\^\^/gu, "^");
    }
    params.push([name, value]);
  }
  return {
    name: rawName.toUpperCase(),
    params: Object.fromEntries(params),
    value: unescapeIcalText(line.slice(separator + 1))
  };
}
function findIcalValueSeparator(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ":" && !quoted) {
      return index;
    }
  }
  return -1;
}
function splitIcalHeader(header) {
  const parts = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < header.length; index++) {
    if (header[index] === '"') {
      quoted = !quoted;
    } else if (header[index] === ";" && !quoted) {
      parts.push(header.slice(start, index));
      start = index + 1;
    }
  }
  if (quoted) {
    return null;
  }
  parts.push(header.slice(start));
  return parts;
}
function unescapeIcalText(value) {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      const escaped = value[++index];
      if (escaped === "n" || escaped === "N") {
        result += "\n";
      } else if (escaped === "\\" || escaped === "," || escaped === ";") {
        result += escaped;
      } else {
        result += `\\${escaped}`;
      }
    } else {
      result += character;
    }
  }
  return result;
}
function createIcalEventRecord(properties) {
  var _a;
  const start = properties.find((property) => property.name === "DTSTART");
  if (!(start == null ? void 0 : start.value)) {
    return null;
  }
  const startType = getIcalDateType(start);
  if (!startType) {
    return null;
  }
  const end = properties.find((property) => property.name === "DTEND");
  const endType = end ? getIcalDateType(end) : void 0;
  if (end && (!endType || endType !== startType)) {
    return null;
  }
  const fields = {
    start: start.value,
    start_type: startType,
    all_day: startType === "DATE"
  };
  if (start.params.TZID) {
    fields.start_tzid = start.params.TZID;
  }
  if (end) {
    fields.end = end.value;
    fields.end_type = endType;
    if (end.params.TZID) {
      fields.end_tzid = end.params.TZID;
    }
  }
  const setFirstProperty = (name, field) => {
    var _a2;
    const value = (_a2 = properties.find((property) => property.name === name)) == null ? void 0 : _a2.value;
    if (value !== void 0) {
      fields[field] = value;
    }
  };
  setFirstProperty("SUMMARY", "summary");
  setFirstProperty("DESCRIPTION", "description");
  setFirstProperty("LOCATION", "location");
  setFirstProperty("UID", "uid");
  const categories = properties.filter((property) => property.name === "CATEGORIES" || property.name === "CATEGORY").map((property) => property.value).filter((value) => value.length > 0);
  if (categories.length > 0) {
    fields.category = categories.join(", ");
  }
  const organizer = properties.find((property) => property.name === "ORGANIZER");
  if (organizer) {
    fields.responsible = (_a = organizer.params.CN) != null ? _a : organizer.value;
  }
  const safeFields = sanitizeJsonFields(fields);
  return { format: "json", id: getJsonId(safeFields), fields: safeFields };
}
function getIcalDateType(property) {
  var _a;
  const type = (_a = property.params.VALUE) == null ? void 0 : _a.toUpperCase();
  if (type === "DATE" || !type && /^\d{8}$/u.test(property.value)) {
    return /^\d{8}$/u.test(property.value) ? "DATE" : null;
  }
  if (type && type !== "DATE-TIME") {
    return null;
  }
  return /^\d{8}T\d{6}Z?$/u.test(property.value) ? "DATE-TIME" : null;
}
function parseHtmlRecords(kind, body, recoverMalformedTimetableDetail = false) {
  var _a, _b;
  let root;
  try {
    root = (0, import_node_html_parser.parse)(body);
  } catch {
    return { status: "invalid", kind, reason: "malformed-html" };
  }
  if (hasLoginRequiredContent(root)) {
    return { status: "unavailable", kind, reason: "login-required" };
  }
  const visibleText = root.text.toLocaleLowerCase("de-DE").normalize("NFKC");
  if (hasPermissionDenial(visibleText)) {
    return { status: "unavailable", kind, reason: "permission-denied" };
  }
  if (hasFeatureUnavailable(visibleText)) {
    return { status: "unavailable", kind, reason: "feature-unavailable" };
  }
  const isValidHtml = (0, import_node_html_parser.valid)(body);
  const canRecoverMalformedTimetableDetail = kind === "timetable" && recoverMalformedTimetableDetail;
  if (!isValidHtml && !canRecoverMalformedTimetableDetail) {
    return { status: "invalid", kind, reason: "malformed-html" };
  }
  if (kind === "substitutions") {
    return parseOwnSubstitutionTables(root);
  }
  if (kind === "substitution-dates") {
    return parseSubstitutionDates(root);
  }
  if (kind === "account") {
    return parseAccountHtml(root);
  }
  if (kind === "lessons") {
    const parentLessons = parseParentLessonTabs(root);
    if (parentLessons) {
      return parentLessons;
    }
  }
  if (kind === "timetable") {
    const parentTimetable = parseParentTimetableIndex(root);
    if (parentTimetable) {
      return parentTimetable;
    }
  }
  const spec = htmlSpec(kind);
  if (!spec) {
    return { status: "unavailable", kind, reason: "unsupported-html-structure" };
  }
  const folderRecords = kind === "file-metadata" ? parseFileFolderRecords(root) : [];
  if (folderRecords === null) {
    return { status: "invalid", kind, reason: "unexpected-html-structure" };
  }
  const pageTables = spec.getTables(root);
  const tables = !isValidHtml && canRecoverMalformedTimetableDetail ? pageTables.filter(({ section }) => section === "own") : pageTables;
  if (!isValidHtml && tables.length === 0) {
    return { status: "invalid", kind, reason: "malformed-html" };
  }
  if (!tables.length) {
    if (kind === "file-metadata" && folderRecords.length > 0) {
      return { status: "complete", kind, records: folderRecords, groups: [] };
    }
    const elements = allElements(root);
    const htmlTables = elements.filter((element) => element.tagName === "TABLE");
    const hasTable = htmlTables.length > 0;
    if (kind === "timetable") {
      const hasTimetableSection = elements.some(
        (element) => TIMETABLE_SECTION_IDS.some((sectionId) => sectionId === element.getAttribute("id"))
      );
      if (!hasTimetableSection && hasTable && htmlTables.every((table) => table.closest(".footer") !== null)) {
        return { status: "unavailable", kind, reason: "feature-unavailable" };
      }
      return {
        status: "invalid",
        kind,
        reason: hasTimetableSection ? "timetable-tables-missing" : hasTable ? "timetable-sections-missing-with-tables" : "timetable-sections-missing-no-tables"
      };
    }
    if (kind === "lessons") {
      const hasLessonSection = elements.some(
        (element) => LESSON_SECTION_IDS.some((sectionId) => sectionId === element.getAttribute("id"))
      );
      return {
        status: "invalid",
        kind,
        reason: hasLessonSection ? "lessons-tables-missing" : hasTable ? "lessons-sections-missing-with-tables" : "lessons-sections-missing-no-tables"
      };
    }
    return { status: "invalid", kind, reason: "unexpected-html-structure" };
  }
  const groups = [];
  const records = [...folderRecords];
  for (const { section, table, printableRowsOnly } of tables) {
    const result = parseTable(
      table,
      section,
      printableRowsOnly != null ? printableRowsOnly : false,
      kind === "lessons" && section === "mappen",
      kind === "file-metadata"
    );
    if (!result.confirmedStructure) {
      return {
        status: "invalid",
        kind,
        reason: !isValidHtml && canRecoverMalformedTimetableDetail ? "malformed-html" : kind === "lessons" ? "lessons-table-structure-invalid" : "unexpected-html-structure"
      };
    }
    if (kind === "file-metadata") {
      const fileHeaders = (_b = (_a = result.group.headers[0]) == null ? void 0 : _a.map((cell) => fileFieldForHeader(cell.text))) != null ? _b : [];
      if (!["name", "modified", "size"].every((header) => fileHeaders.includes(header))) {
        return { status: "invalid", kind, reason: "unexpected-html-structure" };
      }
      const fileRecords = toFileJsonRecords(result.records);
      groups.push({ ...result.group, recordIds: fileRecords.map((record) => record.id) });
      records.push(...fileRecords);
    } else {
      groups.push(result.group);
      const tableRecords = kind === "timetable" ? result.records.map((record) => ({
        ...record,
        fields: record.fields.map((field) => ({ ...field, text: normalizeText(field.text) }))
      })) : result.records;
      records.push(...tableRecords);
    }
  }
  if (hasDuplicateRecordIds(records)) {
    return {
      status: "invalid",
      kind,
      reason: kind === "lessons" ? "duplicate-record-ids" : "unexpected-html-structure"
    };
  }
  return { status: "complete", kind, records, groups };
}
function isLearnersTabPanel(root, panel) {
  var _a, _b;
  const panelId = panel.getAttribute("id");
  const labelledBy = ((_a = panel.getAttribute("aria-labelledby")) != null ? _a : "").split(/\s+/u).filter(Boolean);
  const labels = allElements(root).filter((element) => {
    const elementId = element.getAttribute("id");
    return typeof elementId === "string" && labelledBy.includes(elementId) || typeof panelId === "string" && (element.getAttribute("aria-controls") === panelId || element.getAttribute("href") === `#${panelId}`);
  });
  const labelText = [(_b = panel.getAttribute("aria-label")) != null ? _b : "", ...labels.map((label) => label.text)].join(" ").replace(/\s+/gu, " ").toLocaleLowerCase();
  return /\blernende\b/u.test(labelText);
}
function parseParentTimetableIndex(root) {
  var _a, _b, _c;
  const learnerPanels = new Set(
    allElements(root).filter(
      (element) => element.getAttribute("role") === "tabpanel" && isLearnersTabPanel(root, element)
    )
  );
  const links = root.querySelectorAll("a[href]").filter((anchor) => {
    var _a2, _b2;
    const panel = anchor.closest('[role="tabpanel"]');
    if (!panel || !learnerPanels.has(panel) || !((_a2 = anchor.parentNode) == null ? void 0 : _a2.classList.contains("list-group"))) {
      return false;
    }
    return /(?:[?&])a=detail_klasse(?:&|$)/u.test((_b2 = anchor.getAttribute("href")) != null ? _b2 : "");
  });
  if (links.length === 0) {
    return null;
  }
  const invalid = {
    status: "invalid",
    kind: "timetable",
    reason: "timetable-child-links-invalid"
  };
  if (links.length > MAX_PARENT_CHILD_TABS) {
    return invalid;
  }
  const ids = /* @__PURE__ */ new Set();
  const children = [];
  for (const anchor of links) {
    const href = (_a = anchor.getAttribute("href")) != null ? _a : "";
    let url;
    try {
      url = new URL(href, "https://start.schulportal.hessen.de");
    } catch {
      return invalid;
    }
    const queryKeys = [...url.searchParams.keys()].sort();
    const classId = (_b = url.searchParams.get("k")) != null ? _b : "";
    const studentId = (_c = url.searchParams.get("p")) != null ? _c : "";
    if (url.origin !== "https://start.schulportal.hessen.de" || url.pathname !== "/stundenplan.php" || url.hash || JSON.stringify(queryKeys) !== JSON.stringify(["a", "e", "k", "p"]) || url.searchParams.get("e") !== "1" || url.searchParams.get("a") !== "detail_klasse" || !/^[A-Za-z0-9_-]{1,32}$/u.test(classId) || !/^[0-9]{1,20}$/u.test(studentId)) {
      return invalid;
    }
    const id = (0, import_node_crypto.createHash)("sha256").update(`p${studentId}`).digest("hex");
    if (ids.has(id)) {
      return invalid;
    }
    ids.add(id);
    children.push({
      id,
      requestPath: `/stundenplan.php?e=1&a=detail_klasse&k=${encodeURIComponent(classId)}&p=${studentId}`
    });
  }
  return { status: "complete", kind: "timetable", records: [], groups: [], timetableChildren: children };
}
function parseParentLessonTabs(root) {
  var _a, _b, _c, _d, _e, _f;
  const anchors = root.querySelectorAll("a[href]").filter(
    (anchor) => {
      var _a2;
      return anchor.getAttribute("data-toggle") === "tab" && ((_a2 = anchor.getAttribute("href")) != null ? _a2 : "").startsWith("#p");
    }
  );
  if (anchors.length === 0) {
    return null;
  }
  const invalid = { status: "invalid", kind: "lessons", reason: "lessons-tabs-invalid" };
  if (anchors.length > MAX_PARENT_CHILD_TABS) {
    return invalid;
  }
  const childIds = /* @__PURE__ */ new Set();
  const children = [];
  const groups = [];
  const records = [];
  for (const anchor of anchors) {
    const href = (_a = anchor.getAttribute("href")) != null ? _a : "";
    if (!/^#p\d+$/u.test(href)) {
      return invalid;
    }
    const name = anchor.text.replace(/\s+/gu, " ").trim();
    if (!name || name.length > 256 || hasControlCharacters(name)) {
      return invalid;
    }
    const matchingPanels = allElements(root).filter((element) => element.getAttribute("id") === href.slice(1));
    if (matchingPanels.length !== 1 || ((_b = matchingPanels[0]) == null ? void 0 : _b.tagName) !== "DIV" || !matchingPanels[0].classList.contains("tab-pane")) {
      return invalid;
    }
    const childId = (0, import_node_crypto.createHash)("sha256").update(href.slice(1)).digest("hex");
    if (childIds.has(childId)) {
      return invalid;
    }
    childIds.add(childId);
    const panel = matchingPanels[0];
    if (!panel) {
      return invalid;
    }
    const nestedPanes = getNestedChildLessonPanes(panel, href.slice(1));
    if (!nestedPanes) {
      return invalid;
    }
    const childRecords = [];
    const verifiedSections = /* @__PURE__ */ new Set();
    const tables = [];
    const directTables = tablesWithin(panel).filter(
      (table) => !isNestedTable(table, panel) && table.closest(".tab-pane") === panel
    );
    for (const [tableIndex, table] of directTables.entries()) {
      tables.push({ table, tableIndex });
    }
    for (const pane of nestedPanes) {
      const paneTables = tablesWithin(pane.element).filter(
        (table) => !isNestedTable(table, pane.element) && table.closest(".tab-pane") === pane.element
      );
      for (const [tableIndex, table] of paneTables.entries()) {
        tables.push({ table, tableIndex, childSection: pane.section, paneId: pane.id });
      }
    }
    if (tables.length === 0) {
      return invalid;
    }
    for (const { table, tableIndex, childSection, paneId } of tables) {
      const result = parseTable(table, "child-lessons", false, true, false);
      if (!result.confirmedStructure) {
        return invalid;
      }
      verifiedSections.add(childSection != null ? childSection : "other");
      const idCounts = /* @__PURE__ */ new Map();
      for (const record of result.records) {
        idCounts.set(record.id, ((_c = idCounts.get(record.id)) != null ? _c : 0) + 1);
      }
      const tableRecordIds = /* @__PURE__ */ new Set();
      const tableRecords = [];
      for (const record of result.records) {
        let sourceId = record.id;
        if (((_d = idCounts.get(record.id)) != null ? _d : 0) > 1) {
          if (record.format !== "html") {
            return invalid;
          }
          sourceId = hashId({
            attributes: record.attributes,
            fields: record.fields,
            courseId: (_e = record.courseId) != null ? _e : null,
            markers: (_f = record.markers) != null ? _f : []
          });
        }
        if (tableRecordIds.has(sourceId)) {
          return invalid;
        }
        tableRecordIds.add(sourceId);
        const tableScope = paneId ? `lesson-child:${childId}:pane:${hashSourceId(paneId)}:table:${tableIndex}:${sourceId}` : `lesson-child:${childId}:table:${tableIndex}:${sourceId}`;
        const id = hashSourceId(tableScope);
        tableRecords.push({
          ...record,
          id,
          section: "child-lessons",
          ...childSection ? { childSection } : {},
          context: { childId }
        });
      }
      childRecords.push(...tableRecords);
      groups.push({
        ...result.group,
        section: "child-lessons",
        recordIds: tableRecords.map((record) => record.id)
      });
    }
    children.push({
      id: childId,
      name,
      records: childRecords,
      ...verifiedSections.size > 0 ? { sections: CHILD_LESSON_SECTION_ORDER.filter((section) => verifiedSections.has(section)) } : {}
    });
    records.push(...childRecords);
  }
  if (hasDuplicateRecordIds(records)) {
    return invalid;
  }
  return { status: "complete", kind: "lessons", records, groups, children };
}
function getNestedChildLessonPanes(panel, parentId) {
  var _a;
  const anchors = panel.querySelectorAll("a[href]").filter((anchor) => anchor.getAttribute("data-toggle") === "tab" && anchor.closest(".tab-pane") === panel);
  const paneIds = /* @__PURE__ */ new Set();
  const panes = [];
  for (const anchor of anchors) {
    const match = /^#([A-Za-z][A-Za-z0-9_-]*)$/u.exec((_a = anchor.getAttribute("href")) != null ? _a : "");
    if (!(match == null ? void 0 : match[1]) || match[1] === parentId) {
      continue;
    }
    const id = match[1];
    const section = getChildLessonSection(id, parentId.slice(1));
    const matchingPanes = allElements(panel).filter((element) => element.getAttribute("id") === id);
    const pane = matchingPanes.length === 1 ? matchingPanes[0] : void 0;
    let owner = pane == null ? void 0 : pane.parentNode;
    while (owner && owner !== panel && !owner.classList.contains("tab-pane")) {
      owner = owner.parentNode;
    }
    if (!pane || pane.tagName !== "DIV" || !pane.classList.contains("tab-pane") || owner !== panel) {
      if (section !== "other") {
        return null;
      }
      continue;
    }
    if (paneIds.has(id)) {
      return null;
    }
    paneIds.add(id);
    panes.push({ id, element: pane, section });
  }
  return panes;
}
function getChildLessonSection(paneId, parentNumericId) {
  if (paneId === `aktuell${parentNumericId}`) {
    return "current";
  }
  if (paneId === `mappen${parentNumericId}`) {
    return "assignments";
  }
  if (paneId === `anwesend${parentNumericId}`) {
    return "attendance";
  }
  return "other";
}
function parseAccountHtml(root) {
  const tableBodies = root.querySelectorAll("div.col-md-12 table.table.table-striped tbody");
  const records = [];
  const profileFieldOccurrences = /* @__PURE__ */ new Map();
  for (const body of tableBodies) {
    for (const row of body.querySelectorAll("tr")) {
      const cells = row.querySelectorAll(":scope > td, :scope > th");
      if (cells.length < 2) {
        return { status: "invalid", kind: "account", reason: "unexpected-html-structure" };
      }
      const label = cells[0].text.trim();
      if (!label) {
        return { status: "invalid", kind: "account", reason: "unexpected-html-structure" };
      }
      if (/(?:\b(?:password|passwort|kennwort|credential|session|sitzung|token|cookie|authentication|auth|secret|geheim)\b|zugangsdaten)/iu.test(
        label
      )) {
        continue;
      }
      const fields = sanitizeJsonFields({ recordType: "profile", label, value: cells[1].text });
      records.push({ format: "json", id: getProfileFieldId(label, profileFieldOccurrences), fields });
    }
  }
  const accountTypes = /* @__PURE__ */ new Set();
  for (const icon of root.querySelectorAll(".nav.navbar-nav.navbar-right > li > a > i")) {
    if (icon.classList.contains("fa-child")) {
      accountTypes.add("student");
    } else if (icon.classList.contains("fa-user-circle")) {
      accountTypes.add("parent");
    } else if (icon.classList.contains("fa-user")) {
      accountTypes.add("teacher");
    }
  }
  if (accountTypes.size > 1) {
    return { status: "invalid", kind: "account", reason: "unexpected-html-structure" };
  }
  const accountType = [...accountTypes][0];
  if (accountType) {
    const fields = { recordType: "account-type", type: accountType };
    records.push({ format: "json", id: hashSourceId("account-type"), fields });
  }
  if (tableBodies.length === 0 && !accountType) {
    return { status: "unavailable", kind: "account", reason: "unsupported-html-structure" };
  }
  if (hasDuplicateRecordIds(records)) {
    return { status: "invalid", kind: "account", reason: "unexpected-html-structure" };
  }
  return { status: "complete", kind: "account", records, groups: [] };
}
function parseOwnSubstitutionTables(root) {
  var _a, _b, _c, _d;
  const kind = "substitutions";
  if (root.querySelectorAll(".btn-ganzerplan").length > 0) {
    return { status: "unavailable", kind, reason: "substitution-whole-plan-button-present" };
  }
  const rawDates = allElements(root).map((element) => element.getAttribute("data-tag")).filter((value) => value !== void 0);
  if (rawDates.length === 0) {
    return { status: "unavailable", kind, reason: "substitution-date-tags-missing" };
  }
  if (rawDates.length > MAX_SUBSTITUTION_DATES) {
    return { status: "unavailable", kind, reason: "substitution-date-count-exceeded" };
  }
  const dates = rawDates.map(normalizeSubstitutionDate);
  if (dates.some((date) => date === null) || new Set(dates).size !== dates.length) {
    return { status: "invalid", kind, reason: "unexpected-html-structure" };
  }
  const expectedDates = new Set(dates.filter((date) => date !== null));
  const tables = allElements(root).filter(
    (element) => {
      var _a2;
      return element.tagName === "TABLE" && ((_a2 = element.getAttribute("id")) != null ? _a2 : "").startsWith("vtable");
    }
  );
  if (tables.length === 0) {
    return { status: "unavailable", kind, reason: "substitution-vtable-tables-missing" };
  }
  if (tables.length !== expectedDates.size) {
    return { status: "invalid", kind, reason: "unexpected-html-structure" };
  }
  const tablesByDate = /* @__PURE__ */ new Map();
  for (const table of tables) {
    const tableId = (_a = table.getAttribute("id")) != null ? _a : "";
    const date = normalizeSubstitutionDate(tableId.slice("vtable".length));
    if (!date || !expectedDates.has(date) || tablesByDate.has(date)) {
      return { status: "invalid", kind, reason: "unexpected-html-structure" };
    }
    tablesByDate.set(date, table);
  }
  if (tablesByDate.size !== expectedDates.size) {
    return { status: "invalid", kind, reason: "unexpected-html-structure" };
  }
  const records = [];
  for (const date of expectedDates) {
    const table = tablesByDate.get(date);
    if (!table) {
      return { status: "invalid", kind, reason: "unexpected-html-structure" };
    }
    const parsed = parseTable(table, date, false, false, true);
    const headers = (_b = parsed.group.headers[0]) == null ? void 0 : _b.map((cell) => normalizeText(cell.text));
    const tableRows = table.querySelectorAll("tr").filter((row) => row.closest("table") === table);
    const emptyMessageRows = tableRows.filter(isExplicitNoSubstitutionRow);
    const isEmptySubstitutionDay = emptyMessageRows.length === 1 && parsed.records.length === 1 && ((_c = parsed.records[0]) == null ? void 0 : _c.fields.length) === 1;
    if (!parsed.confirmedStructure || parsed.group.headers.length !== 1 || !headers || headers.length !== SUBSTITUTION_HEADERS.length || headers.some((header, index) => header !== SUBSTITUTION_HEADERS[index]) || tableRows.length !== parsed.group.headers.length + parsed.records.length || parsed.records.some((row) => row.fields.length !== SUBSTITUTION_HEADERS.length && !isEmptySubstitutionDay)) {
      return { status: "invalid", kind, reason: "unexpected-html-structure" };
    }
    if (isEmptySubstitutionDay) {
      continue;
    }
    const duplicateCounts = /* @__PURE__ */ new Map();
    for (const row of parsed.records) {
      const columns = row.fields.map((field, columnIndex) => {
        var _a2;
        return {
          header: (_a2 = SUBSTITUTION_HEADERS[columnIndex]) != null ? _a2 : "",
          value: normalizeText(field.text)
        };
      });
      const fields = sanitizeJsonFields({ portalDate: date, columns });
      const identity = hashId({ portalDate: date, fields });
      const occurrence = (_d = duplicateCounts.get(identity)) != null ? _d : 0;
      duplicateCounts.set(identity, occurrence + 1);
      const safeColumns = fields.columns;
      if (!Array.isArray(safeColumns) || safeColumns.length !== SUBSTITUTION_HEADERS.length || safeColumns.some(
        (column, columnIndex) => !isRecord(column) || column.header !== SUBSTITUTION_HEADERS[columnIndex] || typeof column.value !== "string"
      )) {
        return { status: "invalid", kind, reason: "unexpected-html-structure" };
      }
      records.push({
        format: "json",
        id: hashId({ portalDate: date, fields, occurrence }),
        fields
      });
    }
  }
  if (hasDuplicateRecordIds(records)) {
    return { status: "invalid", kind, reason: "unexpected-html-structure" };
  }
  return { status: "complete", kind, records, groups: [] };
}
function isExplicitNoSubstitutionRow(row) {
  const cells = row.querySelectorAll(":scope > th, :scope > td");
  const cell = cells[0];
  if (cells.length !== 1 || !cell || cell.tagName !== "TD" || cell.getAttribute("colspan") !== String(SUBSTITUTION_HEADERS.length)) {
    return false;
  }
  const text = normalizeText(getVisibleCellText(cell)).toLocaleLowerCase("de").normalize("NFD").replace(/[\u0300-\u036f]/gu, "");
  return /\bkeine\b[^.!?]{0,80}\beintrag\w*\b/u.test(text) && /\bvertret\w*/u.test(text);
}
function parseSubstitutionDates(root) {
  const kind = "substitution-dates";
  const rawDates = allElements(root).map((element) => element.getAttribute("data-tag")).filter((value) => value !== void 0);
  if (rawDates.length === 0) {
    return { status: "unavailable", kind, reason: "unsupported-html-structure" };
  }
  const dates = rawDates.map(normalizeSubstitutionDate);
  if (dates.some((date) => date === null)) {
    return { status: "invalid", kind, reason: "unexpected-html-structure" };
  }
  const uniqueDates = /* @__PURE__ */ new Map();
  for (const [index, date] of dates.entries()) {
    const portalTag = rawDates[index];
    if (date && portalTag && !uniqueDates.has(date)) {
      uniqueDates.set(date, portalTag);
    }
  }
  const records = [...uniqueDates].map(([date, portalTag]) => ({
    format: "json",
    id: hashSourceId(date),
    fields: { date, portalTag }
  }));
  return { status: "complete", kind, records, groups: [] };
}
function toFileJsonRecords(rows) {
  return rows.map((row) => {
    var _a;
    const fileId = row.attributes["data-id"];
    const fields = { recordType: "file" };
    if (fileId && /^\d+$/u.test(fileId)) {
      fields.fileId = fileId;
    }
    for (const cell of row.fields) {
      const field = fileFieldForHeader((_a = cell.header) != null ? _a : "");
      if (field && cell.text) {
        fields[field] = cell.text;
      }
    }
    const columns = row.fields.flatMap(
      (cell) => cell.header === null ? [] : [{ header: cell.header, value: cell.text }]
    );
    if (columns.length > 0) {
      fields.columns = columns;
    }
    const attributes = sanitizeAttributes(row.attributes, true);
    if (Object.keys(attributes).length > 0) {
      fields.attributes = attributes;
    }
    const safeFields = sanitizeJsonFields(fields, true);
    return {
      format: "json",
      id: fileId && /^\d+$/u.test(fileId) ? hashSourceId(`file:${fileId}`) : hashId(safeFields),
      fields: safeFields
    };
  });
}
function fileFieldForHeader(header) {
  const normalized = normalizeRecordKey(header);
  if (["name", "filename", "dateiname"].includes(normalized)) {
    return "name";
  }
  if (["aenderung", "anderung", "geandert", "modified", "lastmodified"].includes(normalized)) {
    return "modified";
  }
  if (["groesse", "grosse", "size", "filesize"].includes(normalized)) {
    return "size";
  }
  if (["note", "hinweis", "bemerkung", "beschreibung", "description"].includes(normalized)) {
    return "note";
  }
  return null;
}
function parseFileFolderRecords(root) {
  const folders = allElements(root).filter((element) => element.classList.contains("folder"));
  const records = [];
  const seenIds = /* @__PURE__ */ new Set();
  for (const folder of folders) {
    const folderId = folder.getAttribute("data-id");
    const caption = findFolderChild(folder, ".caption");
    const description = findFolderChild(folder, ".desc");
    if (!folderId || !/^\d+$/u.test(folderId) || !caption || !description || seenIds.has(folderId)) {
      return null;
    }
    seenIds.add(folderId);
    const fields = {
      recordType: "folder",
      folderId,
      name: caption.text,
      description: description.text
    };
    const count = findFolderChild(folder, '[title="Anzahl Ordner"]');
    if (count) {
      const countText = count.text.trim();
      if (countText) {
        const subfolderCount = parseSubfolderCount(countText);
        if (subfolderCount === null) {
          return null;
        }
        fields.subfolderCount = subfolderCount;
      }
    }
    const safeFields = sanitizeJsonFields(fields);
    records.push({
      format: "json",
      id: hashSourceId(`folder:${folderId}`),
      fields: safeFields
    });
  }
  return records;
}
function findFolderChild(folder, selector) {
  var _a;
  return (_a = folder.querySelectorAll(selector).find((element) => element.closest(".folder") === folder)) != null ? _a : null;
}
function parseSubfolderCount(value) {
  const match = /^(\d+)(?:\s+Ordner)?$/u.exec(value);
  if (!match) {
    return null;
  }
  const count = Number(match[1]);
  return Number.isSafeInteger(count) ? count : null;
}
function normalizeSubstitutionDate(value) {
  const normalized = value.replace(/^(\d{2})_(\d{2})_(\d{4})$/u, "$1.$2.$3");
  return isPortalDate(normalized) ? normalized : null;
}
function isPortalDate(value) {
  var _a;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value);
  if (!match) {
    return false;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= ((_a = daysInMonth[month - 1]) != null ? _a : 0);
}
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function htmlSpec(kind) {
  if (kind === "timetable") {
    return { getTables: (root) => tablesInSections(root, TIMETABLE_SECTION_IDS) };
  }
  if (kind === "learning-groups") {
    return { getTables: (root) => tablesInSections(root, ["LGs", "klausuren"]) };
  }
  if (kind === "lessons") {
    return {
      getTables: (root) => tablesInSections(root, LESSON_SECTION_IDS).map(
        (table) => table.section === "mappen" ? { ...table, printableRowsOnly: true } : table
      )
    };
  }
  if (kind === "file-metadata") {
    return {
      getTables: (root) => allElements(root).filter((element) => element.tagName === "TABLE" && element.getAttribute("id") === "files").map((table) => ({ section: "files", table }))
    };
  }
  return null;
}
function tablesInSections(root, sectionIds) {
  var _a;
  const sections = allElements(root).filter((element) => {
    var _a2;
    return sectionIds.includes((_a2 = element.getAttribute("id")) != null ? _a2 : "");
  });
  const result = [];
  for (const section of sections) {
    for (const table of tablesWithin(section)) {
      if (nearestSection(table, sectionIds) === section) {
        result.push({ section: (_a = section.getAttribute("id")) != null ? _a : "", table });
      }
    }
  }
  return result;
}
function allElements(root) {
  return [root, ...root.querySelectorAll("*")];
}
function tablesWithin(section) {
  return [...section.tagName === "TABLE" ? [section] : [], ...section.querySelectorAll("table")];
}
function isNestedTable(table, section) {
  let current = table.parentNode;
  while (current && current !== section) {
    if (current.tagName === "TABLE") {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}
function nearestSection(element, sectionIds) {
  var _a;
  let current = element;
  while (current) {
    if (sectionIds.includes((_a = current.getAttribute("id")) != null ? _a : "")) {
      return current;
    }
    current = current.parentNode;
  }
  return null;
}
function parseTable(table, section, printableOnly, includeLessonDetails, omitUrls) {
  var _a;
  const rows = table.querySelectorAll("tr").filter((row) => row.closest("table") === table);
  const headerRows = [];
  const dataRows = [];
  let encounteredData = false;
  for (const row of rows) {
    const cells = row.querySelectorAll(":scope > th, :scope > td");
    if (!cells.length) {
      continue;
    }
    const isInHead = ((_a = row.closest("thead")) == null ? void 0 : _a.closest("table")) === table;
    const isLeadingHeader = !encounteredData && cells.every((cell) => cell.tagName === "TH");
    if (isInHead || isLeadingHeader) {
      headerRows.push(row);
    } else {
      encounteredData = true;
      if (!printableOnly || row.classList.contains("printable")) {
        dataRows.push(row);
      }
    }
  }
  const headers = headerRows.map(
    (row) => row.querySelectorAll(":scope > th, :scope > td").map((cell) => parseCell(cell, omitUrls))
  );
  const primaryHeaders = headers.length === 1 ? headers[0].map((cell) => cell.text) : [];
  const records = dataRows.map((row) => {
    const cells = row.querySelectorAll(":scope > th, :scope > td").map((cell) => parseCell(cell, omitUrls));
    const fields = cells.map((cell, index) => {
      var _a2;
      return { ...cell, header: (_a2 = primaryHeaders[index]) != null ? _a2 : null };
    });
    const rowAttributes = sanitizeAttributes(row.attributes, omitUrls);
    const dataId = row.getAttribute("data-id");
    const safeAttributes = omitUrls ? {
      ...Object.fromEntries(Object.entries(rowAttributes).filter(([name]) => name !== "data-id")),
      ...dataId && /^\d+$/u.test(dataId) ? { "data-id": dataId } : {}
    } : rowAttributes;
    const courseId = includeLessonDetails ? getLessonCourseId(row) : void 0;
    const markers = includeLessonDetails ? getLessonMarkers(row) : [];
    const normalized = {
      headers: headers.map((headerRow) => headerRow.map((cell) => normalizeText(cell.text))),
      fields: fields.map((field) => ({
        header: field.header === null ? null : normalizeText(field.header),
        text: normalizeText(field.text),
        links: field.links.map(normalizeLink),
        attributes: normalizeAttributes(field.attributes)
      })),
      attributes: normalizeAttributes(safeAttributes),
      ...courseId ? { courseId } : {},
      markers
    };
    return {
      format: "html",
      id: getHtmlId(row, normalized),
      section,
      attributes: safeAttributes,
      fields,
      ...markers.length > 0 ? { markers } : {},
      ...courseId ? { courseId } : {}
    };
  });
  const group = {
    section,
    tableAttributes: sanitizeAttributes(table.attributes, omitUrls),
    headers,
    recordIds: records.map((record) => record.id)
  };
  return { group, records, confirmedStructure: records.length > 0 || headers.length > 0 };
}
function parseCell(cell, omitUrls) {
  return {
    header: null,
    text: getVisibleCellText(cell),
    links: cell.querySelectorAll("a").filter((link) => !hasHiddenAncestor(link, cell)).map((link) => ({
      href: omitUrls ? null : safeRelativePath(link.getAttribute("href")),
      text: getVisibleCellText(link),
      attributes: sanitizeAttributes(link.attributes, omitUrls)
    })),
    attributes: sanitizeAttributes(cell.attributes, omitUrls)
  };
}
function getVisibleCellText(cell) {
  var _a;
  if (isHiddenElement(cell)) {
    return "";
  }
  const visibleCell = cell.clone();
  for (const hidden of visibleCell.querySelectorAll('[hidden], [aria-hidden="true"], .hidden, .hidden_encoded')) {
    hidden.remove();
  }
  for (const styled of visibleCell.querySelectorAll("[style]")) {
    const style = (_a = styled.getAttribute("style")) != null ? _a : "";
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/iu.test(style)) {
      styled.remove();
    }
  }
  return visibleCell.text;
}
function isHiddenElement(element) {
  var _a;
  const style = (_a = element.getAttribute("style")) != null ? _a : "";
  return element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || element.classList.contains("hidden") || element.classList.contains("hidden_encoded") || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/iu.test(style);
}
function hasHiddenAncestor(element, boundary) {
  let current = element;
  while (current && current !== boundary) {
    if (isHiddenElement(current)) {
      return true;
    }
    current = current.parentNode;
  }
  return current !== boundary || isHiddenElement(boundary);
}
function getHtmlId(row, normalized) {
  const dataId = row.getAttribute("data-id");
  for (const sourceId of [
    row.getAttribute("id"),
    dataId && /^\d+$/u.test(dataId) ? dataId : void 0,
    row.getAttribute("data-entry")
  ]) {
    if (isSafeExplicitId(sourceId)) {
      return hashSourceId(sourceId);
    }
  }
  for (const link of row.querySelectorAll("a")) {
    const linkId = link.getAttribute("id");
    if (isSafeExplicitId(linkId)) {
      return hashSourceId(linkId);
    }
  }
  return hashId(normalized);
}
function getLessonCourseId(row) {
  for (const link of row.querySelectorAll("a")) {
    const courseId = parseLessonDetailHref(link.getAttribute("href"));
    if (courseId) {
      return courseId;
    }
  }
  return void 0;
}
function parseLessonDetailHref(href) {
  if (!href || href.includes("#") || href.includes("\\") || hasControlCharacters(href)) {
    return null;
  }
  const match = /^(?:https:\/\/start\.schulportal\.hessen\.de)?(\/?meinunterricht\.php)\?a=view&id=(\d+)$/iu.exec(
    href
  );
  if (!match) {
    return null;
  }
  try {
    const url = new URL(href, "https://start.schulportal.hessen.de/");
    if (url.origin !== "https://start.schulportal.hessen.de" || url.pathname !== "/meinunterricht.php" || url.search !== `?a=view&id=${match[2]}`) {
      return null;
    }
    return match[2];
  } catch {
    return null;
  }
}
function getLessonMarkers(row) {
  const classNames = ["homework", "realHomework", "undone"];
  return classNames.filter(
    (className) => [row, ...row.querySelectorAll("*")].some((element) => element.classList.contains(className))
  );
}
function isSafeExplicitId(value) {
  if (!(value == null ? void 0 : value.trim()) || value.includes("?") || value.includes("#") || hasControlCharacters(value)) {
    return false;
  }
  return !/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(value) && !/(?:session|sess(?:ion)?id|sid|token|cookie|csrf|auth|secret|password|credential|ticket)/iu.test(value);
}
function hasControlCharacters(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== void 0 && (codePoint < 32 || codePoint >= 127 && codePoint <= 159)) {
      return true;
    }
  }
  return false;
}
function safeRelativePath(value) {
  if (!value || value !== value.trim() || value.includes("?") || value.includes("#") || value.includes("\\") || hasControlCharacters(value)) {
    return null;
  }
  if (value.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(value)) {
    return null;
  }
  if (/(?:^|\/)(?:session|sessid|sid|token|auth|ticket|csrf|login|logout)(?:\/|$)/iu.test(value) || /(?:jsessionid|sessionid|sessid|sid|token|csrf|auth|ticket)=/iu.test(value)) {
    return null;
  }
  try {
    return new URL(value, "https://portal.invalid/").origin === "https://portal.invalid" ? value : null;
  } catch {
    return null;
  }
}
function sanitizeAttributes(attributes, omitUrls = false) {
  const safe = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "id" || omitUrls && name === "data-id" || /(?:session|sess(?:ion)?id|sid|token|cookie|csrf|auth|secret|password|credential|ticket)/iu.test(name)) {
      continue;
    }
    const isUrlAttribute = name === "href" || /(?:^|[-_])(?:url|uri|link|src|href|action|download)$/iu.test(name);
    if (omitUrls && isUrlAttribute) {
      continue;
    }
    if (isUrlAttribute) {
      const path = safeRelativePath(value);
      if (path) {
        safe.push([name, path]);
      }
      continue;
    }
    if (/^(?:srcset|src|action|formaction|on\w+)$/iu.test(name) || value.includes("?") || hasControlCharacters(value) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(value) || /(?:https?:\/\/|\/\/\S+)/iu.test(value) || /(?:^|[?&;,\s])(?:session|sessid|sid|token|cookie|csrf|auth|secret|password|credential|ticket)=/iu.test(
      value
    )) {
      continue;
    }
    safe.push([name, value]);
  }
  return Object.fromEntries(safe);
}
function normalizeLink(link) {
  return {
    href: link.href === null ? null : normalizeText(link.href),
    text: normalizeText(link.text),
    attributes: normalizeAttributes(link.attributes)
  };
}
function normalizeAttributes(attributes) {
  return Object.fromEntries(
    Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, normalizeText(value)])
  );
}
function normalizeText(value) {
  return value.replace(/\s+/gu, " ").trim();
}
function hashId(value) {
  return `hash:${(0, import_node_crypto.createHash)("sha256").update(canonicalJson(value)).digest("hex")}`;
}
function hasLoginRequiredContent(root) {
  const visibleText = normalizeText(root.text).toLowerCase();
  if (/\blogin\s+nötig\b|\bmuss(?:\s+man)?\s+eingeloggt\s+sein\b|\blogin\s+required\b|\bmust\s+be\s+logged\s+in\b/u.test(
    visibleText
  )) {
    return true;
  }
  return root.querySelectorAll("form").some((form) => {
    var _a;
    const inputs = form.querySelectorAll("input");
    const names = inputs.map((input) => {
      var _a2, _b;
      return (_b = (_a2 = input.getAttribute("name")) == null ? void 0 : _a2.toLowerCase()) != null ? _b : "";
    });
    const hasUser = names.some((name) => ["user", "user2", "username", "login"].includes(name));
    const hasPassword = inputs.some(
      (input) => {
        var _a2, _b;
        return ((_a2 = input.getAttribute("type")) == null ? void 0 : _a2.toLowerCase()) === "password" || ((_b = input.getAttribute("name")) == null ? void 0 : _b.toLowerCase()) === "password";
      }
    );
    return hasPassword && (hasUser || /login|anmeld/i.test((_a = form.getAttribute("action")) != null ? _a : ""));
  });
}
function hasPermissionDenial(text) {
  return /\bkeine\s+(?:zugriffs)?berechtigung\b|\bzugriff\s+verweigert\b|\bnot\s+authorized\b|\baccess\s+denied\b|\bpermission\s+denied\b/u.test(
    text
  );
}
function hasFeatureUnavailable(text) {
  return /\b(?:funktion|bereich|modul|feature)\b.{0,48}\b(?:nicht\s+verfügbar|nicht\s+freigeschaltet|deaktiviert)\b|\b(?:funktion|bereich|modul|feature)\b.{0,48}\b(?:not\s+available|not\s+enabled|disabled)\b/u.test(
    text
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_SUBSTITUTION_DATES,
  TIMETABLE_WEEKDAY_IDS,
  canonicalCalendarDateField,
  canonicalPortalColumn,
  canonicalPortalSection,
  getProfileFieldDisplayName,
  getProfileFieldId,
  getProfileSummaryField,
  isTimetableDateHeader,
  normalizePortalHeader,
  normalizePortalLabel,
  normalizeTimetableWeekday,
  parsePortalResource,
  parsePortalTimetableChildDetail
});
//# sourceMappingURL=portal-parser.js.map
