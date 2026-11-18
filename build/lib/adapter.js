"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var adapter_exports = {};
__export(adapter_exports, {
  SchulportalHessenAdapter: () => SchulportalHessenAdapter
});
module.exports = __toCommonJS(adapter_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_config_validation = require("./config-validation");
var import_dynamic_record_sync = require("./dynamic-record-sync");
var import_id_path_segments = require("./id-path-segments");
var import_portal_dates = require("./portal-dates");
var import_portal_data_requests = require("./portal-data-requests");
var import_portal_diagnostics = require("./portal-diagnostics");
var import_portal_session = require("./portal-session");
var import_portal_school_directory = require("./portal-school-directory");
var import_refresh_coordinator = require("./refresh-coordinator");
var import_portal_parser = require("./portal-parser");
const STUDENTS_BASE = "students";
const INBOX_BASE = "inbox";
const INBOX_CATEGORIES = ["read", "unread"];
const SUBSTITUTION_COLUMN_ALIASES = {
  stunde: "period",
  klasse: "class",
  vertretung: "substitution",
  lehrkraft: "teacher",
  fach: "subject",
  raum: "room",
  hinweis: "note"
};
const ACCOUNT_NAME_STATE = "info.accountName";
const ACCOUNT_TYPE_STATE = "info.accountType";
const ROOT_LAST_ERROR_STATE = "info.lastError";
const RESOURCE_BASES = {
  account: "profile",
  timetable: `${STUDENTS_BASE}.timetable`,
  substitutions: "substitutions",
  calendar: "calendar.portal",
  "school-calendar": "calendar.school",
  lessons: `${STUDENTS_BASE}.lessons`,
  "learning-groups": "learningGroups",
  messages: INBOX_BASE,
  "file-metadata": "files"
};
function getResourceBase(resource) {
  return RESOURCE_BASES[resource];
}
function getSubstitutionIsoDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value);
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = /* @__PURE__ */ new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function isIsoCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) {
    return false;
  }
  return getSubstitutionIsoDate(`${match[3]}.${match[2]}.${match[1]}`) === value;
}
function getSubstitutionRecordDate(record) {
  return record.format === "json" ? getSubstitutionIsoDate(record.fields.portalDate) : null;
}
function groupDailySubstitutionRows(records) {
  var _a;
  const groups = /* @__PURE__ */ new Map();
  for (const record of records) {
    const date = getSubstitutionRecordDate(record);
    if (!date) {
      continue;
    }
    const dateRows = (_a = groups.get(date)) != null ? _a : [];
    groups.set(date, dateRows);
    const columns = record.format === "json" ? record.fields.columns : void 0;
    if (!Array.isArray(columns)) {
      continue;
    }
    const row = {
      period: "",
      class: "",
      substitution: "",
      teacher: "",
      subject: "",
      room: "",
      note: ""
    };
    for (const column of columns) {
      if (typeof column !== "object" || column === null || Array.isArray(column)) {
        continue;
      }
      const pair = column;
      if (typeof pair.header !== "string" || typeof pair.value !== "string") {
        continue;
      }
      const header = pair.header.trim().toLowerCase();
      if (Object.hasOwn(SUBSTITUTION_COLUMN_ALIASES, header)) {
        row[SUBSTITUTION_COLUMN_ALIASES[header]] = pair.value;
      }
    }
    dateRows.push(row);
  }
  return groups;
}
const SCHOOL_OPTIONS_CACHE_MS = 6 * 60 * 6e4;
const REFRESH_STATE = "info.refresh";
const ROOT_CONNECTION_STATE = "info.connection";
const ROOT_STATUS_STATE = "info.status";
const ROOT_LAST_UPDATE_STATE = "info.lastUpdate";
const RESOURCE_NAMES = {
  account: "Profile",
  timetable: "Timetable",
  substitutions: "Substitutions",
  calendar: "Portal calendar",
  "school-calendar": "School calendar",
  lessons: "Lessons and assignments",
  "learning-groups": "Learning groups and assessments",
  messages: "Inbox",
  "file-metadata": "Files"
};
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CHILD_LESSON_SECTION_NAMES = {
  current: "Current lessons",
  assignments: "Assignments",
  history: "History",
  attendance: "Attendance",
  marks: "Marks",
  exams: "Exams",
  other: "Other student data"
};
function getFixedResourceChildPaths(resource, base) {
  const paths = /* @__PURE__ */ new Set(["status", "count", "lastUpdate", "json", "recordIds", "recordPaths", "records"]);
  if (resource === "messages") {
    paths.add("unreadCount");
  }
  if (resource === "substitutions" && base === getResourceBase(resource)) {
    paths.add("dailyJsonDates");
  }
  if (resource === "lessons" && base.endsWith(".lessons")) {
    paths.add("sectionIds");
    for (const section of Object.keys(CHILD_LESSON_SECTION_NAMES)) {
      paths.add(section);
    }
  }
  if (resource === "timetable" && base.endsWith(".timetable")) {
    for (const path of ["today", "tomorrow", "week"]) {
      paths.add(path);
    }
  }
  return [...paths];
}
function getChildLessonSection(record) {
  if (record.format !== "html") {
    return "other";
  }
  if (record.childSection) {
    return record.childSection;
  }
  switch (record.section) {
    case "mappen":
      return "assignments";
    case "history":
      return "history";
    case "attendanceTable":
    case "anwesend":
      return "attendance";
    case "marks":
      return "marks";
    case "klausuren":
      return "exams";
    case "current":
    case "aktuell":
      return "current";
    default:
      return "other";
  }
}
function isProfileRecord(record) {
  return record.format === "json" && record.fields.recordType === "profile";
}
function getProfileFieldValue(records, aliases) {
  const normalizedAliases = new Set(aliases);
  const values = records.flatMap(
    (record) => isProfileRecord(record) && typeof record.fields.label === "string" && typeof record.fields.value === "string" && normalizedAliases.has(normalizeCalendarFieldName(record.fields.label)) ? [record.fields.value] : []
  );
  return values.length === 1 ? values[0] : "";
}
function getAccountType(records) {
  for (const record of records) {
    if (record.format === "json" && record.fields.recordType === "account-type" && (record.fields.type === "parent" || record.fields.type === "student" || record.fields.type === "teacher")) {
      return record.fields.type;
    }
  }
  return "";
}
const PORTAL_SECTION_NAMES = /* @__PURE__ */ new Map([
  ["LGs", "Learning groups"],
  ["klausuren", "Exams"],
  ["mappen", "Lesson folders"],
  ["attendanceTable", "Attendance"]
]);
function getReadableRecordName(record, forDisplay = false) {
  var _a;
  const sectionName = record.format === "html" ? record.childSection ? CHILD_LESSON_SECTION_NAMES[record.childSection] : record.section === "own" ? "Personal timetable" : record.section === "all" ? "Class timetable" : (_a = forDisplay ? PORTAL_SECTION_NAMES.get(record.section) : void 0) != null ? _a : record.section : typeof record.fields.name === "string" ? record.fields.name : typeof record.fields.title === "string" ? record.fields.title : typeof record.fields.subject === "string" ? record.fields.subject : typeof record.fields.summary === "string" ? record.fields.summary : typeof record.fields.label === "string" ? record.fields.label : "Portal record";
  const values = record.format === "html" ? record.fields.map((field) => field.text) : [];
  const readableValues = values.map((value) => value.replace(/\s+/gu, " ").trim()).filter((value) => value.length > 0 && !/^[a-f0-9]{24,}$/iu.test(value)).slice(0, 2);
  return [sectionName, ...readableValues].join(" \u2014 ").slice(0, 160);
}
const CALENDAR_START_FIELDS = /* @__PURE__ */ new Set(["start", "startsat", "anfang"]);
const CALENDAR_END_FIELDS = /* @__PURE__ */ new Set(["end", "endsat", "ende"]);
const BERLIN_CALENDAR_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
function normalizeCalendarFieldName(name) {
  return name.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").replace(/ß/gu, "ss").toLowerCase().replace(/[^a-z0-9]/gu, "");
}
function getCalendarEventDates(record) {
  if (record.format !== "json" || typeof record.fields !== "object" || record.fields === null) {
    return null;
  }
  const fields = record.fields;
  const start = getCalendarDateField(fields, CALENDAR_START_FIELDS, "start_type", "start_tzid");
  if (!start) {
    return null;
  }
  const hasEnd = Object.entries(fields).some(
    ([name, value]) => CALENDAR_END_FIELDS.has(normalizeCalendarFieldName(name)) && value !== null && value !== void 0 && !(typeof value === "string" && !value.trim())
  );
  const end = getCalendarDateField(fields, CALENDAR_END_FIELDS, "end_type", "end_tzid");
  if (hasEnd && !end) {
    return null;
  }
  return { start, end, endIsExclusive: fields.end_type === "DATE" };
}
function getCalendarDateField(fields, aliases, typeField, timeZoneField) {
  var _a;
  const values = Object.entries(fields).filter(([name]) => aliases.has(normalizeCalendarFieldName(name))).map(([, value]) => value).filter((value) => !(typeof value === "string" && !value.trim()));
  if (values.length === 0 || !values.every((value) => typeof value === "string")) {
    return null;
  }
  const dates = values.map((value) => parseCalendarDate(value, fields[typeField], fields[timeZoneField]));
  if (dates.some((date) => date === null) || new Set(dates).size !== 1) {
    return null;
  }
  return (_a = dates[0]) != null ? _a : null;
}
function parseCalendarDate(value, dateType, timeZone) {
  const trimmed = value.trim();
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  const compactDate = /^(\d{4})(\d{2})(\d{2})$/u.exec(trimmed);
  if (isoDate || compactDate) {
    if (dateType === "DATE-TIME") {
      return null;
    }
    const [, year2, month2, day2] = isoDate != null ? isoDate : compactDate;
    return isValidCalendarDate(Number(year2), Number(month2), Number(day2)) ? `${year2}-${month2}-${day2}` : null;
  }
  const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/iu.exec(trimmed);
  const compactDateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/iu.exec(trimmed);
  const dateTime = isoDateTime != null ? isoDateTime : compactDateTime;
  if (!dateTime || dateType === "DATE") {
    return null;
  }
  const [, year, month, day, hour, minute, second = "0", zone = ""] = dateTime;
  if (!isValidCalendarDate(Number(year), Number(month), Number(day)) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return null;
  }
  if (timeZone !== void 0 && timeZone !== null && typeof timeZone !== "string") {
    return null;
  }
  const timeZoneName = typeof timeZone === "string" ? timeZone : "";
  const isUtc = /^(?:UTC|ETC\/UTC|GMT)$/iu.test(timeZoneName);
  const berlinLocal = !timeZoneName || timeZoneName === "Europe/Berlin";
  if (!zone && berlinLocal) {
    return `${year}-${month}-${day}`;
  }
  if (!zone && !isUtc) {
    return null;
  }
  const normalizedValue = isoDateTime ? `${trimmed.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2")}${!zone && isUtc ? "Z" : ""}` : `${year}-${month}-${day}T${hour}:${minute}:${second}${zone || "Z"}`;
  const instant = Date.parse(normalizedValue);
  if (!Number.isFinite(instant)) {
    return null;
  }
  const parts = Object.fromEntries(
    BERLIN_CALENDAR_FORMATTER.formatToParts(instant).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function isValidCalendarDate(year, month, day) {
  var _a;
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day <= ((_a = days[month - 1]) != null ? _a : 0);
}
function isCurrentCalendarEvent(record, today) {
  const dates = getCalendarEventDates(record);
  if (!dates || dates.end !== null && dates.end < dates.start) {
    return false;
  }
  if (!dates.end) {
    return dates.start >= today;
  }
  return dates.endIsExclusive ? dates.end > today : dates.end >= today;
}
function isCompactRecordResource(resource) {
  return resource === "calendar" || resource === "school-calendar" || resource === "file-metadata";
}
function getReadableRecordPathName(resource, record) {
  if (resource === "calendar" || resource === "school-calendar") {
    const dates = getCalendarEventDates(record);
    if (!dates) {
      throw new Error("Calendar record is missing a readable start date");
    }
    return `${dates.start}-${getReadableRecordName(record)}`;
  }
  if (resource === "account") {
    return `field-${getReadableRecordName(record)}`;
  }
  return getReadableRecordName(record);
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
const SAFE_READABLE_PATH_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_READABLE_RECORD_PATH_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
function getSubstitutionRecordPaths(records) {
  var _a, _b;
  const entriesByChannel = /* @__PURE__ */ new Map();
  for (const record of records) {
    const sourceId = (0, import_dynamic_record_sync.toSafeDynamicRecordId)(record.id);
    const parentChannel = (_a = getSubstitutionRecordDate(record)) != null ? _a : "undated";
    const entries = (_b = entriesByChannel.get(parentChannel)) != null ? _b : [];
    entries.push({ sourceId, displayName: "portal-record" });
    entriesByChannel.set(parentChannel, entries);
  }
  const paths = /* @__PURE__ */ new Map();
  for (const [parentChannel, entries] of entriesByChannel) {
    for (const [sourceId, segment] of (0, import_id_path_segments.allocateIdPathSegments)(entries)) {
      paths.set(sourceId, `${parentChannel}.${segment}`);
    }
  }
  return paths;
}
function allocateSegmentsWithReservations(entries, reservations) {
  const fixedReservations = reservations.filter(({ fixed }) => fixed);
  const fixedEntries = fixedReservations.map(({ path }, index) => ({
    sourceId: `!fixed-${index}-${path.toLowerCase()}`,
    displayName: path.toLowerCase()
  }));
  const baseline = (0, import_id_path_segments.allocateIdPathSegments)([...entries, ...fixedEntries]);
  const reservedPaths = [
    ...new Set(
      reservations.map(({ ownerId, path, fixed }) => ({ ownerId, path: path.toLowerCase(), fixed })).filter(
        ({ ownerId, path, fixed }) => {
          var _a;
          return SAFE_READABLE_PATH_PATTERN.test(path) && (fixed || ((_a = baseline.get(ownerId)) == null ? void 0 : _a.toLowerCase()) !== path);
        }
      ).map(({ path }) => path)
    )
  ].sort();
  if (reservedPaths.length === 0) {
    return new Map(entries.map(({ sourceId }) => [sourceId, baseline.get(sourceId)]));
  }
  const reservedEntries = reservedPaths.map((path, index) => ({
    sourceId: `!reserved-${index}-${path}`,
    displayName: path
  }));
  const allocated = (0, import_id_path_segments.allocateIdPathSegments)([...entries, ...reservedEntries]);
  return new Map(entries.map(({ sourceId }) => [sourceId, allocated.get(sourceId)]));
}
function normalizeFieldLabel(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US").replace(/ß/gu, "ss");
}
function normalizeFieldHeader(value) {
  return normalizeFieldLabel(value).replace(/[^a-z0-9]+/gu, " ").trim();
}
const COMBINED_LESSON_DETAILS_HEADER = normalizeFieldHeader(
  "Thema Datum / Inhalt (wenn hinterlegt) / Hausaufgaben (wenn hinterlegt)"
);
function isTimetablePeriodHeader(header) {
  const normalized = normalizeFieldHeader(header);
  return normalized === "stunde" || normalized === "period";
}
function getVerifiedTimetablePeriodNumber(value) {
  var _a, _b;
  const normalized = value.replace(/\s+/gu, " ").trim();
  const match = /^\s*(\d{1,2})(?:(?:\s*\(\s*((?:[01]?\d|2[0-3]):[0-5]\d)\s*[-–—]\s*((?:[01]?\d|2[0-3]):[0-5]\d)\s*\))|(?:\s+((?:[01]?\d|2[0-3]):[0-5]\d)\s*[-–—]\s*((?:[01]?\d|2[0-3]):[0-5]\d)(?:\s+(\d{1,2})\.)?))?$/u.exec(
    normalized
  );
  if (!match) {
    return null;
  }
  const period = Number(match[1]);
  if (!Number.isSafeInteger(period) || period < 1 || match[6] !== void 0 && Number(match[6]) !== period) {
    return null;
  }
  const startTime = (_a = match[2]) != null ? _a : match[4];
  const endTime = (_b = match[3]) != null ? _b : match[5];
  if (startTime && endTime) {
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);
    if (startHour === void 0 || startMinute === void 0 || endHour === void 0 || endMinute === void 0 || startHour * 60 + startMinute >= endHour * 60 + endMinute) {
      return null;
    }
  }
  return String(period);
}
function getRecordTimetablePeriodNumber(record) {
  if (record.format !== "html") {
    return null;
  }
  const periodFields = record.fields.filter(
    (field) => typeof field.header === "string" && isTimetablePeriodHeader(field.header)
  );
  return periodFields.length === 1 ? getVerifiedTimetablePeriodNumber(periodFields[0].text) : null;
}
function getTimetableLessonIds(records) {
  const occurrences = /* @__PURE__ */ new Map();
  return records.map((record, index) => {
    var _a;
    const period = getRecordTimetablePeriodNumber(record);
    if (period !== null) {
      const base = period.padStart(2, "0");
      const occurrence = ((_a = occurrences.get(base)) != null ? _a : 0) + 1;
      occurrences.set(base, occurrence);
      return occurrence === 1 ? base : `${base}_${occurrence}`;
    }
    return `lesson_${String(index + 1).padStart(2, "0")}`;
  });
}
function getFieldId(label, index, usedIds) {
  const base = normalizeFieldLabel(label).replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 64).replace(/_+$/gu, "") || `column_${String(index + 1).padStart(2, "0")}`;
  let suffix = 1;
  let candidate = base;
  while (usedIds.has(candidate)) {
    suffix++;
    candidate = `${base.slice(0, 64 - String(suffix).length - 1)}_${suffix}`;
  }
  usedIds.add(candidate);
  return candidate;
}
const PORTAL_COLUMN_ALIASES = new Map([
  ...Object.entries(SUBSTITUTION_COLUMN_ALIASES),
  ["datum", "date"],
  ["wochentag", "weekday"],
  ["tag", "day"],
  ["kurs", "course"],
  ["weiteres", "additional information"],
  ["anwesend", "present"],
  ["entschuldigt", "excused"],
  ["andere schulische veranstaltung", "other school event"],
  [COMBINED_LESSON_DETAILS_HEADER, "lesson details"]
]);
const KNOWN_ENGLISH_COLUMN_HEADERS = /* @__PURE__ */ new Set([
  ...PORTAL_COLUMN_ALIASES.values(),
  "assessment",
  "course name",
  "description",
  "end",
  "end time",
  "entry",
  "homework",
  "item",
  "lesson",
  "mark",
  "name",
  "start",
  "start time",
  "time",
  "title",
  "topic"
]);
function getColumnDescriptor(header, index, value, usedIds, previousIds) {
  const normalized = normalizeFieldHeader(header != null ? header : "");
  const alias = PORTAL_COLUMN_ALIASES.get(normalized);
  const knownName = alias ? `${alias[0].toUpperCase()}${alias.slice(1)}` : header && KNOWN_ENGLISH_COLUMN_HEADERS.has(normalized) ? header.trim() : void 0;
  const name = knownName != null ? knownName : `Column ${index + 1}`;
  const columnId = `column_${String(index + 1).padStart(2, "0")}`;
  const id = getFieldId(knownName != null ? knownName : columnId, index, usedIds);
  const previousId = getFieldId((header == null ? void 0 : header.trim()) ? header : columnId, index, previousIds);
  return { id, previousId, name, value, type: "string", role: "text" };
}
function getRecordFieldDescriptors(record, resource) {
  const usedIds = /* @__PURE__ */ new Set();
  if (record.format === "html") {
    const previousIds2 = /* @__PURE__ */ new Set();
    const timetablePeriodNumber = resource === "timetable" ? getRecordTimetablePeriodNumber(record) : null;
    return record.fields.flatMap((field, index) => {
      const isPeriodField = resource === "timetable" && field.header !== null && isTimetablePeriodHeader(field.header);
      const value = isPeriodField ? timetablePeriodNumber : field.text;
      return typeof value === "string" ? [getColumnDescriptor(field.header, index, value, usedIds, previousIds2)] : [];
    });
  }
  const descriptors = Object.entries(record.fields).map(([key, value], index) => {
    let stateValue;
    let type;
    let role;
    if (value === null) {
      stateValue = "null";
      type = "string";
      role = "json";
    } else if (typeof value === "string") {
      stateValue = value;
      type = "string";
      role = "text";
    } else if (typeof value === "boolean") {
      stateValue = value;
      type = "boolean";
      role = "indicator";
    } else if (typeof value === "number" && Number.isFinite(value)) {
      stateValue = value;
      type = "number";
      role = "value";
    } else {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== "string") {
        throw new Error("Invalid JSON record field");
      }
      stateValue = serialized;
      type = "string";
      role = "json";
    }
    return {
      id: getFieldId(key, index, usedIds),
      name: key,
      value: stateValue,
      type,
      role
    };
  });
  const columns = resource === "substitutions" ? record.fields.columns : void 0;
  if (!Array.isArray(columns)) {
    return descriptors;
  }
  const previousIds = new Set(usedIds);
  columns.forEach((column, index) => {
    if (typeof column !== "object" || column === null || Array.isArray(column)) {
      return;
    }
    const columnRecord = column;
    if (typeof columnRecord.value !== "string") {
      return;
    }
    const header = typeof columnRecord.header === "string" ? columnRecord.header : null;
    descriptors.push(getColumnDescriptor(header, index, columnRecord.value, usedIds, previousIds));
  });
  return descriptors;
}
function getRecordDateFields(record) {
  if (record.format !== "html") {
    return null;
  }
  const fields = record.fields.filter((field) => {
    if (typeof field.header !== "string") {
      return false;
    }
    const label = normalizeFieldLabel(field.header);
    return /date|datum|weekday|wochentag/u.test(label) || /(^|[^a-z])(day|tag)([^a-z]|$)/u.test(label);
  });
  return fields.length > 0 ? fields.map((field) => field.text) : null;
}
function hasExplicitDateSyntax(value) {
  return /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/u.test(value);
}
function getExplicitDate(value) {
  const iso = value.match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:$|\D)/u);
  const european = value.match(/(?:^|\D)(\d{1,2})\.(\d{1,2})\.(\d{4})(?:$|\D)/u);
  const parts = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : european ? [Number(european[3]), Number(european[2]), Number(european[1])] : null;
  if (!parts) {
    return null;
  }
  const [year, month, day] = parts;
  const date = /* @__PURE__ */ new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function getWeekday(value) {
  var _a, _b, _c;
  const token = (_a = normalizeFieldLabel(value.trim()).match(/^[a-z]+/u)) == null ? void 0 : _a[0];
  return (_c = (_b = TIMETABLE_WEEKDAYS.find((day) => day.names.includes(token != null ? token : ""))) == null ? void 0 : _b.id) != null ? _c : null;
}
function getDateWeekday(date) {
  const dayIndex = (/* @__PURE__ */ new Date(`${date}T00:00:00.000Z`)).getUTCDay();
  return TIMETABLE_WEEKDAYS[(dayIndex + 6) % 7].id;
}
function getNextWeekdayDate(today, weekday) {
  const start = /* @__PURE__ */ new Date(`${today}T00:00:00.000Z`);
  const startIndex = (start.getUTCDay() + 6) % 7;
  const targetIndex = TIMETABLE_WEEKDAYS.findIndex((day) => day.id === weekday);
  start.setUTCDate(start.getUTCDate() + (targetIndex - startIndex + 7) % 7);
  return `${start.getUTCFullYear().toString().padStart(4, "0")}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-${String(start.getUTCDate()).padStart(2, "0")}`;
}
function getRecordTimetableDate(record, today) {
  var _a;
  const contextualWeekday = ((_a = record.context) == null ? void 0 : _a.timetableWeekday) ? getWeekday(record.context.timetableWeekday) : null;
  if (contextualWeekday) {
    return getNextWeekdayDate(today, contextualWeekday);
  }
  const dateFields = getRecordDateFields(record);
  if (!dateFields) {
    return null;
  }
  const explicitDates = [];
  const weekdays = [];
  for (const value of dateFields) {
    const date = getExplicitDate(value);
    const weekday2 = getWeekday(value);
    if (!date && hasExplicitDateSyntax(value) || !date && !weekday2) {
      return null;
    }
    if (date) {
      explicitDates.push(date);
    }
    if (weekday2) {
      weekdays.push(weekday2);
    }
  }
  if (explicitDates.length > 0) {
    const date = explicitDates[0];
    if (explicitDates.some((value) => value !== date) || weekdays.some((value) => value !== getDateWeekday(date))) {
      return null;
    }
    return date < today ? getNextWeekdayDate(today, getDateWeekday(date)) : date;
  }
  const weekday = weekdays[0];
  if (!weekday || weekdays.some((value) => value !== weekday)) {
    return null;
  }
  return getNextWeekdayDate(today, weekday);
}
function groupTimetableRecords(records, today) {
  const week = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: []
  };
  const buckets = { today: [], tomorrow: [], week };
  const start = (/* @__PURE__ */ new Date(`${today}T00:00:00.000Z`)).getTime();
  for (const record of records) {
    const date = getRecordTimetableDate(record, today);
    if (!date) {
      return null;
    }
    const offset = Math.floor(((/* @__PURE__ */ new Date(`${date}T00:00:00.000Z`)).getTime() - start) / 864e5);
    if (offset < 0 || offset >= TIMETABLE_WEEKDAYS.length) {
      continue;
    }
    buckets.week[getDateWeekday(date)].push(record);
    if (offset === 0) {
      buckets.today.push(record);
    } else if (offset === 1) {
      buckets.tomorrow.push(record);
    }
  }
  return buckets;
}
function isChildLessonSectionId(value) {
  return Object.prototype.hasOwnProperty.call(CHILD_LESSON_SECTION_NAMES, value);
}
class CredentialUnavailableError extends Error {
  constructor() {
    super("Credential unavailable");
    this.name = "CredentialUnavailableError";
  }
}
class SchulportalHessenAdapter extends utils.Adapter {
  refreshCoordinator = new import_refresh_coordinator.RefreshCoordinator();
  activeSessions = /* @__PURE__ */ new Set();
  refreshTimer;
  activeRefresh = null;
  schoolOptionsCache = null;
  schoolOptionsPromise = null;
  unloading = false;
  /**
   * Construct the adapter instance.
   *
   * @param options Optional ioBroker adapter options.
   */
  constructor(options = {}) {
    super({ ...options, name: "schulportal-hessen" });
    this.on("ready", this.onReady.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  onMessage(message) {
    if (message.command !== "searchSchools" || !message.callback) {
      return;
    }
    const callback = message.callback;
    const payload = message.message;
    const query = typeof payload === "object" && payload !== null ? payload.query : void 0;
    this.log.debug(
      `Admin requested school search (query length: ${typeof query === "string" ? query.trim().length : 0}).`
    );
    void this.getSchoolOptions().then(
      (cachedOptions) => {
        const matches = (0, import_portal_school_directory.searchSchoolOptions)(cachedOptions, query);
        this.log.debug(`School directory search returned ${matches.length} result(s).`);
        this.sendTo(message.from, message.command, matches, callback);
      },
      () => {
        this.log.warn("Unable to load the public Schulportal school directory.");
        this.sendTo(message.from, message.command, [], callback);
      }
    );
  }
  async getSchoolOptions() {
    if (this.schoolOptionsCache && this.schoolOptionsCache.expiresAt > Date.now()) {
      return this.schoolOptionsCache.options;
    }
    if (this.schoolOptionsPromise) {
      return this.schoolOptionsPromise;
    }
    const request = (0, import_portal_school_directory.fetchSchoolOptions)().then((options) => {
      this.schoolOptionsCache = { expiresAt: Date.now() + SCHOOL_OPTIONS_CACHE_MS, options };
      return options;
    });
    this.schoolOptionsPromise = request;
    try {
      return await request;
    } finally {
      if (this.schoolOptionsPromise === request) {
        this.schoolOptionsPromise = null;
      }
    }
  }
  async onReady() {
    const configErrors = (0, import_config_validation.validateAdapterConfig)(this.config);
    const recoverableSchoolSearchConfig = (0, import_config_validation.hasOnlyRecoverableSchoolSearchErrors)(configErrors);
    if (configErrors.length > 0 && !recoverableSchoolSearchConfig) {
      this.log.error(`Invalid adapter configuration: ${configErrors.join("; ")}`);
      this.terminate("Invalid adapter configuration", utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
      return;
    }
    try {
      await this.createObjectTree();
      if (this.unloading) {
        return;
      }
      if (recoverableSchoolSearchConfig) {
        const code = configErrors.includes(import_config_validation.RECOVERABLE_SCHOOL_ID_ERROR) ? "invalid-school-id" : "account-config-incomplete";
        await this.setInvalidConfigStatus(code);
        return;
      }
      this.subscribeStates(REFRESH_STATE);
      if (!this.hasConfiguredAccount()) {
        await this.setNotConfiguredStatus();
        return;
      }
      await this.requestRefresh().catch(() => this.log.warn("Initial portal refresh failed."));
    } catch {
      this.log.error("Adapter initialization failed.");
      this.terminate("Adapter initialization failed", utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
    }
  }
  async createObjectTree() {
    var _a, _b;
    const configured = this.hasConfiguredAccount();
    const accountStatus = configured ? "not-updated" : "not-configured";
    await this.ensureChannel("info", "Adapter information");
    await this.ensureState(ROOT_CONNECTION_STATE, "Account connected", "boolean", "indicator.connected", false);
    await this.ensureState(
      ROOT_STATUS_STATE,
      "Overall status",
      "string",
      "text",
      configured ? "initializing" : "not-configured"
    );
    await this.ensureState(ACCOUNT_NAME_STATE, "Account display name", "string", "text", "");
    await this.setAckState(ACCOUNT_NAME_STATE, (_b = (_a = this.config.accountName) == null ? void 0 : _a.trim()) != null ? _b : "");
    await this.ensureState(ACCOUNT_TYPE_STATE, "Account type", "string", "text", "");
    await this.ensureState(ROOT_LAST_UPDATE_STATE, "Last successful data update", "number", "value.time", 0, "ms");
    await this.ensureState(REFRESH_STATE, "Refresh now", "boolean", "button", false, void 0, true);
    await this.ensureState(ROOT_LAST_ERROR_STATE, "Last safe error code", "string", "text", "");
    await this.ensureChannel("profile", "Profile");
    await this.ensureState("profile.name", "Name", "string", "text", "");
    await this.ensureState("profile.school", "School", "string", "text", "");
    await this.ensureChannel("calendar", "Calendar");
    await this.ensureChannel(INBOX_BASE, "Inbox");
    await this.ensureChannel(STUDENTS_BASE, "Students");
    for (const resource of Object.keys(RESOURCE_NAMES)) {
      await this.createResourceTree(resource, accountStatus, void 0, void 0, resource !== "timetable");
    }
  }
  hasConfiguredAccount() {
    return Boolean(this.config.schoolId && this.config.credentialId);
  }
  getBerlinToday() {
    return (0, import_portal_dates.getPortalDateWindow)().today;
  }
  async setInvalidConfigStatus(code) {
    if (this.unloading) {
      return;
    }
    await this.setAckState(ROOT_CONNECTION_STATE, false);
    await this.setAckState(ROOT_STATUS_STATE, "invalid-config");
    await this.setAckState(ROOT_LAST_ERROR_STATE, code);
    for (const resource of Object.keys(RESOURCE_NAMES)) {
      await this.setResourceStatus(resource, "invalid-config");
    }
  }
  async setNotConfiguredStatus() {
    if (this.unloading) {
      return;
    }
    await this.setAckState(ROOT_CONNECTION_STATE, false);
    await this.setAckState(ROOT_STATUS_STATE, "not-configured");
    await this.setAckState(ROOT_LAST_ERROR_STATE, "");
    for (const resource of Object.keys(RESOURCE_NAMES)) {
      await this.setResourceStatus(resource, "not-configured");
    }
  }
  async setResourceStatus(resource, status) {
    await this.setAckState(`${getResourceBase(resource)}.status`, status);
    if (resource === "messages") {
      for (const category of INBOX_CATEGORIES) {
        await this.setAckState(`${INBOX_BASE}.${category}.status`, status);
      }
    }
  }
  async commitAccountSummary(records) {
    await this.setAckState(ACCOUNT_TYPE_STATE, getAccountType(records));
    await this.setAckState("profile.name", getProfileFieldValue(records, ["name", "fullname"]));
    await this.setAckState("profile.school", getProfileFieldValue(records, ["school", "schule"]));
  }
  async createResourceTree(resource, initialStatus, base = getResourceBase(resource), name = RESOURCE_NAMES[resource], includeDataStates = true) {
    await this.ensureChannel(base, name);
    await this.ensureState(`${base}.status`, "Data area status", "string", "text", initialStatus);
    if (!includeDataStates) {
      return;
    }
    await this.ensureState(`${base}.count`, "Record count", "number", "value", 0);
    if (resource === "messages") {
      await this.ensureState(`${base}.unreadCount`, "Unread message count", "number", "value", 0);
    }
    await this.ensureState(`${base}.lastUpdate`, "Last successful data update", "number", "value.time", 0, "ms");
    await this.ensureState(`${base}.json`, "Complete data (JSON)", "string", "json", "[]");
    if (resource === "messages" && base === INBOX_BASE) {
      for (const category of INBOX_CATEGORIES) {
        const categoryBase = `${INBOX_BASE}.${category}`;
        const categoryName = category === "read" ? "Read messages" : "Unread messages";
        await this.createResourceTree("messages", "not-updated", categoryBase, categoryName, true);
      }
      return;
    }
    await this.ensureState(`${base}.recordIds`, "Internal record manifest (JSON)", "string", "json", "[]");
    await this.ensureState(`${base}.recordPaths`, "Internal record path mapping (JSON)", "string", "json", "{}");
    if (resource === "substitutions" && base === getResourceBase(resource)) {
      await this.ensureState(
        `${base}.dailyJsonDates`,
        "Internal daily substitution JSON date manifest (JSON)",
        "string",
        "json",
        "[]"
      );
    }
  }
  async ensureChannel(id, name) {
    await this.ensureObject(id, { type: "channel", common: { name }, native: {} });
  }
  async ensureChildChannel(id, name, legacyObjectId) {
    var _a, _b;
    const existing = await this.getObjectAsync(id);
    if (!existing) {
      const legacyObject = legacyObjectId ? await this.getObjectAsync(legacyObjectId) : null;
      const legacyName = legacyObject == null ? void 0 : legacyObject.common.name;
      const generatedLegacyName = (_a = legacyObject == null ? void 0 : legacyObject.native) == null ? void 0 : _a.portalChildDisplayName;
      const objectName = typeof legacyName === "string" && typeof generatedLegacyName === "string" && legacyName !== generatedLegacyName ? legacyName : name;
      await this.setObjectNotExistsAsync(id, {
        type: "channel",
        common: { name: objectName },
        native: { portalChildDisplayName: name }
      });
      return;
    }
    const updatedName = (0, import_dynamic_record_sync.getGeneratedObjectNameUpdate)(
      existing.common.name,
      (_b = existing.native) == null ? void 0 : _b.portalChildDisplayName,
      name
    );
    if (updatedName) {
      await this.extendObjectAsync(id, {
        common: { name: updatedName },
        native: { portalChildDisplayName: updatedName }
      });
    }
  }
  async ensureObject(id, object) {
    await this.setObjectNotExistsAsync(id, object);
  }
  async ensureState(id, name, type, role, defaultValue, unit, write = false) {
    await this.setObjectNotExistsAsync(id, {
      type: "state",
      common: {
        name,
        type,
        role,
        read: !write,
        write,
        def: defaultValue,
        ...unit ? { unit } : {}
      },
      native: {}
    });
    if (!await this.getStateAsync(id)) {
      await this.setAckState(id, defaultValue);
    }
  }
  async setAckState(id, value) {
    await this.setStateAsync(id, { val: value, ack: true });
  }
  onStateChange(id, state) {
    if (id !== REFRESH_STATE && id !== `${this.namespace}.${REFRESH_STATE}` || !state || state.ack !== false) {
      return;
    }
    void this.setAckState(REFRESH_STATE, false).catch(() => this.log.warn("Could not acknowledge manual refresh."));
    if (state.val === true) {
      void this.requestRefresh().catch(() => this.log.warn("Manual portal refresh failed."));
    }
  }
  requestRefresh() {
    if (this.unloading) {
      return Promise.resolve();
    }
    if (this.activeRefresh) {
      return this.activeRefresh;
    }
    this.cancelRefreshTimer();
    const refresh = this.refreshCoordinator.run(async () => {
      if (!this.unloading) {
        await this.setAckState(ROOT_STATUS_STATE, "updating");
        if (!this.unloading) {
          await this.refreshAccount();
        }
      }
    });
    this.activeRefresh = refresh;
    const onSettled = () => {
      var _a;
      this.activeRefresh = null;
      if (!this.unloading && this.hasConfiguredAccount()) {
        const intervalMinutes = (_a = this.config.refreshIntervalMinutes) != null ? _a : import_config_validation.DEFAULT_REFRESH_INTERVAL_MINUTES;
        this.refreshTimer = this.setTimeout(() => {
          this.refreshTimer = void 0;
          void this.requestRefresh().catch(() => this.log.warn("Scheduled portal refresh failed."));
        }, intervalMinutes * 6e4);
      }
    };
    void refresh.then(onSettled, onSettled);
    return refresh;
  }
  cancelRefreshTimer() {
    if (this.refreshTimer !== void 0) {
      this.clearTimeout(this.refreshTimer);
      this.refreshTimer = void 0;
    }
  }
  async refreshAccount() {
    if (!this.hasConfiguredAccount()) {
      await this.setNotConfiguredStatus();
      return;
    }
    let outcome;
    try {
      outcome = await this.updateAccount((0, import_portal_dates.getPortalDateWindow)());
    } catch {
      outcome = { connected: false, degraded: true, updated: false, lastError: "internal-error" };
      await this.markAccountUnavailable("internal-error");
    }
    if (this.unloading) {
      return;
    }
    await this.setAckState(ROOT_CONNECTION_STATE, outcome.connected);
    await this.setAckState(
      ROOT_STATUS_STATE,
      outcome.connected ? outcome.degraded ? "partial" : "connected" : "disconnected"
    );
    if (outcome.updated) {
      await this.setAckState(ROOT_LAST_UPDATE_STATE, Date.now());
    }
  }
  async updateAccount(dateWindow) {
    var _a;
    await this.setAckState(ROOT_CONNECTION_STATE, false);
    await this.setAckState(ROOT_STATUS_STATE, "connecting");
    await this.setAckState(ROOT_LAST_ERROR_STATE, "");
    let session;
    try {
      const credentials = await utils.Credentials.getCredentials(
        this,
        this.config.credentialId
      );
      if (this.unloading) {
        return { connected: false, degraded: false, updated: false, lastError: "" };
      }
      if (typeof credentials.values.login !== "string" || credentials.values.login.length === 0 || typeof credentials.values.password !== "string" || credentials.values.password.length === 0) {
        throw new CredentialUnavailableError();
      }
      session = new import_portal_session.PortalSession({
        schoolId: this.config.schoolId,
        username: credentials.values.login,
        password: credentials.values.password
      });
    } catch {
      await this.markAccountUnavailable("credential-unavailable");
      return { connected: false, degraded: true, updated: false, lastError: "credential-unavailable" };
    }
    this.activeSessions.add(session);
    try {
      await session.authenticate();
      if (this.unloading) {
        return { connected: false, degraded: false, updated: false, lastError: "" };
      }
      await this.setAckState(ROOT_CONNECTION_STATE, true);
      const requests = (0, import_portal_data_requests.createPortalResourceRequests)(session, dateWindow);
      let successfulResources = 0;
      let degraded = false;
      let lastError = "";
      for (const request of requests) {
        if (this.unloading) {
          break;
        }
        const result = await this.refreshResource(request.id, request.read, request.parse);
        if (result.success) {
          successfulResources++;
        }
        if (result.degraded) {
          degraded = true;
          lastError || (lastError = `${request.id}:${result.status}`);
        }
      }
      if (this.unloading) {
        return { connected: true, degraded, updated: successfulResources > 0, lastError };
      }
      const updated = successfulResources > 0;
      if (updated) {
        await this.setAckState(ROOT_LAST_UPDATE_STATE, Date.now());
      }
      await this.setAckState(ROOT_STATUS_STATE, degraded ? "partial" : "connected");
      await this.setAckState(ROOT_LAST_ERROR_STATE, lastError);
      return { connected: true, degraded, updated, lastError };
    } catch (error) {
      const portalError = error instanceof import_portal_session.PortalSessionError ? error : void 0;
      const code = (_a = portalError == null ? void 0 : portalError.code) != null ? _a : "internal-error";
      const status = code === "authentication-failed" || code === "handshake-failed" ? "authentication-error" : code;
      const httpStatus = (portalError == null ? void 0 : portalError.httpStatus) && Number.isInteger(portalError.httpStatus) && portalError.httpStatus >= 100 && portalError.httpStatus <= 599 ? `http-${portalError.httpStatus}` : "";
      const lastError = [portalError == null ? void 0 : portalError.diagnosticCode, httpStatus].filter(Boolean).join(":") || code;
      await this.markAccountUnavailable(status, lastError);
      return { connected: false, degraded: true, updated: false, lastError };
    } finally {
      session.close();
      this.activeSessions.delete(session);
    }
  }
  async markAccountUnavailable(status, lastError = status) {
    if (this.unloading) {
      return;
    }
    await this.setAckState(ROOT_CONNECTION_STATE, false);
    await this.setAckState(ROOT_STATUS_STATE, status);
    await this.setAckState(ROOT_LAST_ERROR_STATE, lastError);
    for (const resource of Object.keys(RESOURCE_NAMES)) {
      await this.setResourceStatus(resource, status);
    }
    const detail = lastError !== status ? ` (${lastError})` : "";
    this.log.warn(`Portal account: ${status}${detail}.`);
  }
  async refreshResource(resource, read, parse) {
    var _a, _b;
    const base = getResourceBase(resource);
    try {
      const response = await read();
      if (response.classification !== "success") {
        const diagnosticCode = typeof response.diagnosticCode === "string" && /^[a-z0-9-]{1,96}$/u.test(response.diagnosticCode) ? response.diagnosticCode : void 0;
        const status2 = `${this.responseStatus(response.classification)}${diagnosticCode ? `:${diagnosticCode}` : ""}`;
        if (!this.unloading) {
          await this.setResourceStatus(resource, status2);
          if (resource === "timetable") {
            await this.removeUnconfirmedEmptyTimetableDefaults(base);
            await this.updateKnownChildTimetableStatuses(status2);
          }
          if (diagnosticCode) {
            this.log.debug(`Portal data area ${resource} aggregation stopped (${diagnosticCode}).`);
          }
          if (response.classification === "response-too-large") {
            this.log.debug(
              `Portal data area ${resource} response exceeded its configured limit (${(0, import_portal_diagnostics.formatOversizedResponseDiagnostic)(response)}).`
            );
          }
        }
        return { success: false, degraded: !this.isExpectedUnavailable(status2), status: status2 };
      }
      const parsed = parse ? parse(response.body, response.contentType) : (0, import_portal_parser.parsePortalResource)(
        resource,
        Buffer.from(response.body).toString("utf8"),
        (_a = response.contentType) != null ? _a : void 0
      );
      const children = parsed.status === "complete" ? parsed.children : void 0;
      const childTimetables = parsed.status === "complete" ? parsed.childTimetables : void 0;
      const childTimetablesValid = childTimetables === void 0 || resource === "timetable" && this.isParsedChildTimetables(childTimetables);
      const childMappingMismatch = childTimetablesValid && childTimetables !== void 0 && !await this.hasKnownTimetableChildren(childTimetables);
      const childPathMapping = childTimetables === void 0 ? /* @__PURE__ */ new Map() : await this.readChildPathMapping();
      const timetableToday = childTimetables === void 0 ? void 0 : this.getBerlinToday();
      const childTimetableAssignments = childTimetablesValid && !childMappingMismatch && childTimetables !== void 0 && timetableToday ? childTimetables.map((child) => {
        var _a2;
        return {
          child,
          childPath: (_a2 = childPathMapping.get(child.id)) != null ? _a2 : child.id,
          buckets: groupTimetableRecords(child.records, timetableToday)
        };
      }) : void 0;
      const childTimetableRowsUnassignable = (_b = childTimetableAssignments == null ? void 0 : childTimetableAssignments.some((assignment) => assignment.buckets === null)) != null ? _b : false;
      const completeChildTimetableAssignments = childTimetableAssignments == null ? void 0 : childTimetableAssignments.filter(
        (assignment) => assignment.buckets !== null
      );
      if (parsed.status !== "complete" || !this.isParsedRecordArray(parsed.records) || children !== void 0 && (resource !== "lessons" || !this.isParsedChildLessons(children)) || !childTimetablesValid || childMappingMismatch || childTimetableRowsUnassignable) {
        const status2 = childMappingMismatch ? "invalid-response:unmatched-timetable-child" : childTimetableRowsUnassignable ? "invalid-response:unassignable-timetable-record" : parsed.status === "unavailable" ? parsed.reason : parsed.status === "invalid" ? `invalid-response:${parsed.reason}` : "invalid-response:invalid-records";
        if (!this.unloading) {
          await this.setResourceStatus(resource, status2);
          if (resource === "timetable") {
            await this.removeUnconfirmedEmptyTimetableDefaults(base);
            await this.updateKnownChildTimetableStatuses(status2);
          }
          if (resource === "timetable" && parsed.status === "invalid" && parsed.reason === "timetable-sections-missing-with-tables") {
            this.log.debug(
              `Portal timetable parser rejected response (${(0, import_portal_diagnostics.formatInvalidTimetableDiagnostic)(response)}).`
            );
          }
        }
        return { success: false, degraded: !this.isExpectedUnavailable(status2), status: status2 };
      }
      if (this.unloading) {
        return { success: false, degraded: false, status: "closed" };
      }
      if (resource === "account") {
        await this.commitAccountSummary(parsed.records);
      }
      if (resource === "timetable") {
        await this.createResourceTree("timetable", "not-updated", base, "Timetable", true);
      }
      const childCleanupPending = resource === "lessons" && children !== void 0 ? await this.commitChildLessons(children) : false;
      const childTimetableCleanupPending = resource === "timetable" && completeChildTimetableAssignments !== void 0 ? await this.commitChildTimetables(completeChildTimetableAssignments) : false;
      const rootRecords = childTimetables !== void 0 ? [] : resource === "account" ? parsed.records.filter(isProfileRecord) : resource === "calendar" || resource === "school-calendar" ? parsed.records.filter((record) => isCurrentCalendarEvent(record, this.getBerlinToday())) : parsed.records;
      const cleanupPending = resource === "messages" ? await this.commitMessageCategories(rootRecords) : await this.commitCompleteResource(resource, rootRecords);
      const cleanupPendingAny = cleanupPending || childCleanupPending || childTimetableCleanupPending;
      const status = cleanupPendingAny ? "complete-cleanup-pending" : "complete";
      const updatedAt = Date.now();
      await this.setResourceStatus(resource, status);
      await this.setAckState(`${base}.count`, rootRecords.length);
      await this.setAckState(`${base}.lastUpdate`, updatedAt);
      return { success: true, degraded: cleanupPendingAny, status };
    } catch (error) {
      const status = error instanceof import_portal_session.PortalSessionError ? error.diagnosticCode ? `${error.code}:${error.diagnosticCode}` : error.code : "request-error";
      if (!this.unloading) {
        await this.setResourceStatus(resource, status);
        if (resource === "timetable") {
          await this.removeUnconfirmedEmptyTimetableDefaults(base);
          await this.updateKnownChildTimetableStatuses(status);
        }
        this.log.debug(`Portal data area ${resource} failed (${status}).`);
      }
      return { success: false, degraded: true, status };
    }
  }
  isParsedRecordArray(records) {
    if (!Array.isArray(records)) {
      return false;
    }
    return records.every(
      (record) => typeof record === "object" && record !== null && !Array.isArray(record) && typeof record.id === "string" && record.id.length > 0 && record.id.length <= 4096
    );
  }
  isParsedChildLessons(children) {
    if (!Array.isArray(children)) {
      return false;
    }
    const ids = /* @__PURE__ */ new Set();
    for (const value of children) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const child = value;
      const childId = child.id;
      const records = child.records;
      const sections = child.sections;
      if (typeof childId !== "string" || !/^[a-f0-9]{64}$/u.test(childId) || typeof child.name !== "string" || !child.name.trim() || child.name.length > 256 || !this.isParsedRecordArray(records) || sections !== void 0 && (!Array.isArray(sections) || !sections.every((section) => typeof section === "string" && isChildLessonSectionId(section)) || new Set(sections).size !== sections.length) || ids.has(childId)) {
        return false;
      }
      ids.add(childId);
      if (!records.every(
        (record) => {
          var _a;
          return ((_a = record.context) == null ? void 0 : _a.childId) === childId && (record.format !== "html" || record.childSection === void 0 || isChildLessonSectionId(record.childSection));
        }
      )) {
        return false;
      }
    }
    return true;
  }
  isParsedChildTimetables(children) {
    var _a;
    if (!Array.isArray(children)) {
      return false;
    }
    const ids = /* @__PURE__ */ new Set();
    const recordIds = /* @__PURE__ */ new Set();
    for (const value of children) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const child = value;
      const childId = child.id;
      const records = child.records;
      if (typeof childId !== "string" || !/^[a-f0-9]{64}$/u.test(childId) || !this.isParsedRecordArray(records) || ids.has(childId)) {
        return false;
      }
      const childRecordIds = /* @__PURE__ */ new Set();
      for (const record of records) {
        if (record.format !== "html" || record.section !== "own" || ((_a = record.context) == null ? void 0 : _a.childId) !== childId || recordIds.has(record.id) || childRecordIds.has(record.id)) {
          return false;
        }
        childRecordIds.add(record.id);
      }
      ids.add(childId);
      for (const recordId of childRecordIds) {
        recordIds.add(recordId);
      }
    }
    return true;
  }
  async readChildPathMapping() {
    const state = await this.getStateAsync(`${STUDENTS_BASE}.pathMapping`);
    if (typeof (state == null ? void 0 : state.val) !== "string") {
      return /* @__PURE__ */ new Map();
    }
    try {
      const value = JSON.parse(state.val);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return /* @__PURE__ */ new Map();
      }
      return new Map(
        Object.entries(value).filter(
          (entry) => /^[a-f0-9]{64}$/u.test(entry[0]) && typeof entry[1] === "string" && SAFE_READABLE_PATH_PATTERN.test(entry[1])
        )
      );
    } catch {
      return /* @__PURE__ */ new Map();
    }
  }
  async writeChildPathMapping(mapping) {
    const value = Object.fromEntries(
      [...mapping].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    );
    await this.setAckState(`${STUDENTS_BASE}.pathMapping`, JSON.stringify(value));
  }
  async readPendingChildTimetablePaths() {
    const state = await this.getStateAsync(`${STUDENTS_BASE}.pendingTimetablePaths`);
    if (typeof (state == null ? void 0 : state.val) !== "string") {
      return /* @__PURE__ */ new Map();
    }
    try {
      const value = JSON.parse(state.val);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return /* @__PURE__ */ new Map();
      }
      const paths = /* @__PURE__ */ new Map();
      for (const [sourceId, sourcePaths] of Object.entries(value)) {
        if (!/^[a-f0-9]{64}$/u.test(sourceId) || !Array.isArray(sourcePaths)) {
          continue;
        }
        paths.set(
          sourceId,
          [
            ...new Set(
              sourcePaths.filter(
                (path) => typeof path === "string" && SAFE_READABLE_PATH_PATTERN.test(path)
              )
            )
          ].sort()
        );
      }
      return paths;
    } catch {
      return /* @__PURE__ */ new Map();
    }
  }
  async writePendingChildTimetablePaths(paths) {
    const value = Object.fromEntries(
      [...paths].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([sourceId, sourcePaths]) => [sourceId, [...new Set(sourcePaths)].sort()])
    );
    await this.setAckState(`${STUDENTS_BASE}.pendingTimetablePaths`, JSON.stringify(value));
  }
  async readRecordPathMapping(base) {
    const state = await this.getStateAsync(`${base}.recordPaths`);
    if (typeof (state == null ? void 0 : state.val) !== "string") {
      return /* @__PURE__ */ new Map();
    }
    try {
      const value = JSON.parse(state.val);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return /* @__PURE__ */ new Map();
      }
      const paths = /* @__PURE__ */ new Map();
      for (const [sourceId, sourcePaths] of Object.entries(value)) {
        if (!RECORD_ID_PATTERN.test(sourceId)) {
          continue;
        }
        const candidates = typeof sourcePaths === "string" ? [sourcePaths] : sourcePaths;
        if (!Array.isArray(candidates)) {
          continue;
        }
        const validPaths = [
          ...new Set(
            candidates.filter(
              (path) => typeof path === "string" && SAFE_READABLE_RECORD_PATH_PATTERN.test(path)
            )
          )
        ].sort();
        if (validPaths.length > 0) {
          paths.set(sourceId, validPaths);
        }
      }
      return paths;
    } catch {
      return /* @__PURE__ */ new Map();
    }
  }
  async writeRecordPathMapping(base, mapping) {
    const value = Object.fromEntries(
      [...mapping].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([sourceId, paths]) => [sourceId, [...new Set(paths)].sort()])
    );
    await this.setAckState(`${base}.recordPaths`, JSON.stringify(value));
  }
  async hasKnownTimetableChildren(children) {
    const knownIds = new Set(await this.readRecordManifest(`${STUDENTS_BASE}.recordIds`));
    for (const sourceId of (await this.readPendingChildTimetablePaths()).keys()) {
      knownIds.add(sourceId);
    }
    return children.every((child) => knownIds.has(child.id));
  }
  async hasConfirmedTimetableData(base) {
    const [status, count, lastUpdate, json] = await Promise.all([
      this.getStateAsync(`${base}.status`),
      this.getStateAsync(`${base}.count`),
      this.getStateAsync(`${base}.lastUpdate`),
      this.getStateAsync(`${base}.json`)
    ]);
    if (((status == null ? void 0 : status.val) === "complete" || (status == null ? void 0 : status.val) === "complete-cleanup-pending") && typeof (lastUpdate == null ? void 0 : lastUpdate.val) === "number" && lastUpdate.val > 0) {
      return true;
    }
    if (typeof (count == null ? void 0 : count.val) === "number" && count.val > 0) {
      return true;
    }
    if ((await this.readRecordManifest(`${base}.recordIds`)).length > 0) {
      return true;
    }
    if (typeof (json == null ? void 0 : json.val) === "string" && json.val !== "[]") {
      return true;
    }
    const timetableDays = ["today", "tomorrow", ...TIMETABLE_WEEKDAYS.map((day) => `week.${day.id}`)];
    for (const day of timetableDays) {
      if ((await this.readRecordManifest(`${base}.${day}.lessons.recordIds`)).length > 0) {
        return true;
      }
    }
    return false;
  }
  async removeUnconfirmedEmptyTimetableDefaults(base) {
    try {
      const [status, count, lastUpdate, json, recordIds, recordPaths] = await Promise.all([
        this.getStateAsync(`${base}.status`),
        this.getStateAsync(`${base}.count`),
        this.getStateAsync(`${base}.lastUpdate`),
        this.getStateAsync(`${base}.json`),
        this.getStateAsync(`${base}.recordIds`),
        this.getStateAsync(`${base}.recordPaths`)
      ]);
      if ((status == null ? void 0 : status.val) === "complete" || (status == null ? void 0 : status.val) === "complete-cleanup-pending" || (count == null ? void 0 : count.val) !== 0 || (lastUpdate == null ? void 0 : lastUpdate.val) !== 0 || (json == null ? void 0 : json.val) !== "[]" || (recordIds == null ? void 0 : recordIds.val) !== "[]" || (recordPaths == null ? void 0 : recordPaths.val) !== void 0 && recordPaths.val !== "{}") {
        return;
      }
      for (const stateId of ["count", "lastUpdate", "json", "recordIds", "recordPaths"]) {
        try {
          await this.delObjectAsync(`${base}.${stateId}`);
        } catch {
          this.log.debug("Could not remove unconfirmed timetable defaults.");
        }
      }
    } catch {
      this.log.debug("Could not inspect timetable defaults.");
    }
  }
  async updateKnownChildTimetableStatuses(status) {
    var _a;
    try {
      const childPaths = await this.readChildPathMapping();
      const childIds = new Set(await this.readRecordManifest(`${STUDENTS_BASE}.recordIds`));
      for (const childId of (await this.readPendingChildTimetablePaths()).keys()) {
        childIds.add(childId);
      }
      for (const childId of childIds) {
        try {
          const childBase = `${STUDENTS_BASE}.${(_a = childPaths.get(childId)) != null ? _a : childId}`;
          const child = await this.getObjectAsync(childBase);
          if ((child == null ? void 0 : child.type) !== "channel") {
            continue;
          }
          const timetableBase = `${childBase}.timetable`;
          await this.removeUnconfirmedEmptyTimetableDefaults(timetableBase);
          await this.ensureChannel(timetableBase, "Timetable");
          await this.ensureState(`${timetableBase}.status`, "Data area status", "string", "text", status);
          await this.setAckState(`${timetableBase}.status`, status);
        } catch {
          this.log.debug("Could not update a child timetable status.");
        }
      }
    } catch {
      this.log.debug("Could not read verified child channels for timetable status updates.");
    }
  }
  async commitChildTimetables(children) {
    var _a;
    const pendingCleanup = [];
    const cleanupByChild = new Map(children.map(({ child }) => [child.id, false]));
    const updatedAt = Date.now();
    for (const { child, childPath, buckets } of children) {
      const timetableBase = `${STUDENTS_BASE}.${childPath}.timetable`;
      await this.createResourceTree("timetable", "not-updated", timetableBase, "Timetable");
      const previousIds = await this.readRecordManifest(`${timetableBase}.recordIds`);
      const currentRecordIds = child.records.map((record) => (0, import_dynamic_record_sync.toSafeDynamicRecordId)(record.id));
      const resourcePlan = (0, import_dynamic_record_sync.planDynamicRecordSync)(previousIds, currentRecordIds, true);
      if (!resourcePlan) {
        throw new Error("Could not plan complete timetable record update");
      }
      const dataJson = JSON.stringify(child.records);
      if (typeof dataJson !== "string") {
        throw new Error("Invalid timetable JSON data");
      }
      await this.setAckState(
        `${timetableBase}.recordIds`,
        JSON.stringify([.../* @__PURE__ */ new Set([...previousIds, ...resourcePlan.currentIds])].sort())
      );
      await this.setAckState(`${timetableBase}.json`, dataJson);
      await this.ensureChannel(`${timetableBase}.week`, "Week");
      const dayGroups = [
        { id: "today", name: "Today", records: buckets.today },
        { id: "tomorrow", name: "Tomorrow", records: buckets.tomorrow }
      ];
      for (const day of TIMETABLE_WEEKDAYS) {
        dayGroups.push({
          id: `week.${day.id}`,
          name: `${day.id[0].toUpperCase()}${day.id.slice(1)}`,
          records: buckets.week[day.id]
        });
      }
      for (const day of dayGroups) {
        const dayBase = `${timetableBase}.${day.id}`;
        await this.ensureChannel(dayBase, day.name);
        await this.ensureState(`${dayBase}.lessonCount`, "Lesson count", "number", "value", 0);
        await this.setAckState(`${dayBase}.lessonCount`, day.records.length);
        await this.ensureState(`${dayBase}.hasLessons`, "Has lessons", "boolean", "indicator", false);
        await this.setAckState(`${dayBase}.hasLessons`, day.records.length > 0);
        const lessonsBase = `${dayBase}.lessons`;
        await this.ensureChannel(lessonsBase, "Lessons");
        await this.ensureState(
          `${lessonsBase}.recordIds`,
          "Internal lesson manifest (JSON)",
          "string",
          "json",
          "[]"
        );
        const previousLessonIds = await this.readRecordManifest(`${lessonsBase}.recordIds`);
        const lessonIds = getTimetableLessonIds(day.records);
        const lessonPlan = (0, import_dynamic_record_sync.planDynamicRecordSync)(previousLessonIds, lessonIds, true);
        if (!lessonPlan) {
          throw new Error("Could not plan complete timetable lesson update");
        }
        await this.setAckState(
          `${lessonsBase}.recordIds`,
          JSON.stringify([.../* @__PURE__ */ new Set([...previousLessonIds, ...lessonPlan.currentIds])].sort())
        );
        for (let index = 0; index < day.records.length; index++) {
          const record = day.records[index];
          const lessonId = lessonIds[index];
          if (record && lessonId) {
            const recordSourceId = (0, import_dynamic_record_sync.toSafeDynamicRecordId)(record.id);
            const legacyRecordIds = [
              `${timetableBase}.${recordSourceId}`,
              `${timetableBase}.records.${recordSourceId}`
            ];
            const failed = await this.commitRecordChannel(
              lessonsBase,
              record,
              lessonId,
              legacyRecordIds,
              false,
              "timetable"
            );
            if (failed) {
              cleanupByChild.set(child.id, true);
            }
          }
        }
        pendingCleanup.push({ base: lessonsBase, childId: child.id, ...lessonPlan });
      }
      pendingCleanup.push({ base: timetableBase, childId: child.id, ...resourcePlan });
    }
    for (const plan of pendingCleanup) {
      const failed = await this.cleanStaleRecordChannels(plan.base, plan);
      cleanupByChild.set(plan.childId, Boolean(cleanupByChild.get(plan.childId)) || failed);
    }
    const failedChildPathCleanup = await this.cleanPendingChildTimetablePaths(children);
    for (const { child, childPath } of children) {
      const timetableBase = `${STUDENTS_BASE}.${childPath}.timetable`;
      try {
        await this.delObjectAsync(`${timetableBase}.records`, { recursive: true });
      } catch {
        cleanupByChild.set(child.id, true);
      }
      if (failedChildPathCleanup.has(child.id)) {
        cleanupByChild.set(child.id, true);
      }
      const childCleanupPending = (_a = cleanupByChild.get(child.id)) != null ? _a : false;
      await this.setAckState(
        `${timetableBase}.status`,
        childCleanupPending ? "complete-cleanup-pending" : "complete"
      );
      await this.setAckState(`${timetableBase}.count`, child.records.length);
      await this.setAckState(`${timetableBase}.lastUpdate`, updatedAt);
    }
    return [...cleanupByChild.values()].some(Boolean);
  }
  async cleanPendingChildTimetablePaths(children) {
    var _a;
    const childBase = STUDENTS_BASE;
    const currentChildIds = new Set(await this.readRecordManifest(`${childBase}.recordIds`));
    const mapping = await this.readChildPathMapping();
    const pendingPaths = await this.readPendingChildTimetablePaths();
    const failedCleanup = /* @__PURE__ */ new Set();
    for (const { child, childPath } of children) {
      const remainingPaths = [];
      for (const oldPath of (_a = pendingPaths.get(child.id)) != null ? _a : []) {
        if (oldPath === childPath) {
          continue;
        }
        const usedByAnotherChild = [...mapping].some(
          ([sourceId, path]) => sourceId !== child.id && path === oldPath
        );
        if (usedByAnotherChild) {
          remainingPaths.push(oldPath);
          failedCleanup.add(child.id);
          continue;
        }
        try {
          await this.delObjectAsync(`${childBase}.${oldPath}`, { recursive: true });
        } catch {
          remainingPaths.push(oldPath);
          failedCleanup.add(child.id);
        }
      }
      if (!currentChildIds.has(child.id) && remainingPaths.length === 0) {
        try {
          await this.delObjectAsync(`${childBase}.${childPath}`, { recursive: true });
          mapping.delete(child.id);
          pendingPaths.delete(child.id);
          continue;
        } catch {
          remainingPaths.push(childPath);
          failedCleanup.add(child.id);
        }
      }
      if (remainingPaths.length > 0) {
        pendingPaths.set(child.id, [...new Set(remainingPaths)].sort());
      } else {
        pendingPaths.delete(child.id);
      }
    }
    await this.writePendingChildTimetablePaths(pendingPaths);
    await this.writeChildPathMapping(mapping);
    return failedCleanup;
  }
  getUnreadMessageCount(records) {
    return records.filter((record) => {
      if (record.format !== "json" || typeof record.fields !== "object" || record.fields === null || Array.isArray(record.fields)) {
        return false;
      }
      const fields = record.fields;
      return fields.unread === true && fields.hidden !== true;
    }).length;
  }
  async commitMessageCategories(records) {
    const base = getResourceBase("messages");
    await this.createResourceTree("messages", "not-updated", base, "Inbox", true);
    const categorized = { read: [], unread: [] };
    for (const record of records) {
      if (record.format !== "json" || typeof record.fields !== "object" || record.fields === null || Array.isArray(record.fields)) {
        continue;
      }
      const unread = record.fields.unread;
      if (unread === true) {
        categorized.unread.push(record);
      } else if (unread === false) {
        categorized.read.push(record);
      }
    }
    const updatedAt = Date.now();
    let cleanupPending = false;
    for (const category of INBOX_CATEGORIES) {
      const categoryBase = `${base}.${category}`;
      const categoryCleanupPending = await this.commitCompleteResource(
        "messages",
        categorized[category],
        categoryBase
      );
      cleanupPending || (cleanupPending = categoryCleanupPending);
      await this.setAckState(
        `${categoryBase}.status`,
        categoryCleanupPending ? "complete-cleanup-pending" : "complete"
      );
      await this.setAckState(`${categoryBase}.count`, categorized[category].length);
      await this.setAckState(`${categoryBase}.lastUpdate`, updatedAt);
    }
    const dataJson = JSON.stringify(records);
    if (typeof dataJson !== "string") {
      throw new Error("Invalid message header JSON");
    }
    await this.setAckState(`${base}.count`, records.length);
    await this.setAckState(`${base}.unreadCount`, this.getUnreadMessageCount(records));
    await this.setAckState(`${base}.lastUpdate`, updatedAt);
    await this.setAckState(`${base}.json`, dataJson);
    return cleanupPending;
  }
  async commitChildLessons(children) {
    var _a, _b, _c, _d, _e, _f;
    const base = STUDENTS_BASE;
    const manifestId = `${base}.recordIds`;
    const existingManifest = await this.getStateAsync(manifestId);
    if (children.length === 0 && typeof (existingManifest == null ? void 0 : existingManifest.val) !== "string") {
      return false;
    }
    await this.ensureChannel(base, "Children");
    await this.ensureState(manifestId, "Internal child manifest (JSON)", "string", "json", "[]");
    await this.ensureState(`${base}.pathMapping`, "Internal child path mapping (JSON)", "string", "json", "{}");
    await this.ensureState(
      `${base}.pendingTimetablePaths`,
      "Internal pending timetable paths (JSON)",
      "string",
      "json",
      "{}"
    );
    const previousIds = await this.readRecordManifest(manifestId);
    const previousPaths = await this.readChildPathMapping();
    const previousPendingPaths = await this.readPendingChildTimetablePaths();
    const plan = (0, import_dynamic_record_sync.planDynamicRecordSync)(
      previousIds,
      children.map((child) => child.id),
      true
    );
    if (!plan) {
      return false;
    }
    const pathEntries = children.map((child) => ({ sourceId: child.id, displayName: child.name }));
    const pathReservations = /* @__PURE__ */ new Map();
    for (const path of ["timetable", "lessons", "recordIds", "pathMapping", "pendingTimetablePaths"]) {
      pathReservations.set(`reserved:${path}`, { ownerId: `reserved:${path}`, path, fixed: true });
    }
    const addPathReservation = async (sourceId, path) => {
      if (await this.getObjectAsync(`${base}.${path}`)) {
        pathReservations.set(`${sourceId}:${path}`, { ownerId: sourceId, path });
      }
    };
    for (const [sourceId, path] of previousPaths) {
      await addPathReservation(sourceId, path);
    }
    for (const sourceId of previousIds) {
      if (!previousPaths.has(sourceId)) {
        await addPathReservation(sourceId, sourceId);
      }
    }
    for (const [sourceId, paths] of previousPendingPaths) {
      for (const path of paths) {
        await addPathReservation(sourceId, path);
      }
    }
    for (const child of children) {
      if (!previousPaths.has(child.id)) {
        await addPathReservation(child.id, child.id);
      }
    }
    const childPaths = allocateSegmentsWithReservations(pathEntries, [...pathReservations.values()]);
    let cleanupPending = false;
    for (const child of children) {
      const childPath = childPaths.get(child.id);
      const oldPath = (_a = previousPaths.get(child.id)) != null ? _a : child.id;
      const legacyChildBase = oldPath === childPath ? void 0 : `${base}.${oldPath}`;
      const childBase = `${base}.${childPath}`;
      await this.ensureChildChannel(childBase, child.name, legacyChildBase);
      const updatedAt = Date.now();
      const infoBase = `${childBase}.info`;
      await this.ensureChannel(infoBase, "Student information");
      await this.ensureState(`${infoBase}.id`, "Readable student ID", "string", "text", "");
      await this.ensureState(`${infoBase}.name`, "Student name", "string", "text", "");
      await this.ensureState(`${infoBase}.status`, "Student data status", "string", "text", "not-updated");
      await this.ensureState(
        `${infoBase}.lastUpdate`,
        "Last successful student update",
        "number",
        "value.time",
        0,
        "ms"
      );
      await this.setAckState(`${infoBase}.id`, childPath);
      await this.setAckState(`${infoBase}.name`, child.name);
      const timetableBase = `${childBase}.timetable`;
      await this.createResourceTree("timetable", "not-updated", timetableBase, "Timetable", false);
      if (((_b = await this.getStateAsync(`${timetableBase}.status`)) == null ? void 0 : _b.val) === "feature-unavailable") {
        await this.setAckState(`${timetableBase}.status`, "not-updated");
      }
      await this.removeUnconfirmedEmptyTimetableDefaults(timetableBase);
      const lessonsBase = `${childBase}.lessons`;
      await this.createResourceTree("lessons", "not-updated", lessonsBase, "Lessons and assignments");
      const childCleanupPending = await this.commitCompleteResource("lessons", child.records, lessonsBase);
      const status = childCleanupPending ? "complete-cleanup-pending" : "complete";
      await this.setAckState(`${lessonsBase}.status`, status);
      await this.setAckState(`${lessonsBase}.count`, child.records.length);
      await this.setAckState(`${lessonsBase}.lastUpdate`, updatedAt);
      const sectionRecords = /* @__PURE__ */ new Map();
      for (const section of (_c = child.sections) != null ? _c : []) {
        if (isChildLessonSectionId(section)) {
          sectionRecords.set(section, []);
        }
      }
      for (const record of child.records) {
        const section = getChildLessonSection(record);
        const records = (_d = sectionRecords.get(section)) != null ? _d : [];
        records.push(record);
        sectionRecords.set(section, records);
      }
      const sectionManifestId = `${lessonsBase}.sectionIds`;
      await this.ensureState(
        sectionManifestId,
        "Internal lesson-section manifest (JSON)",
        "string",
        "json",
        "[]"
      );
      const previousSections = (await this.readRecordManifest(sectionManifestId)).filter(isChildLessonSectionId);
      const sectionPlan = (0, import_dynamic_record_sync.planDynamicRecordSync)(previousSections, [...sectionRecords.keys()], true);
      let sectionCleanupPending = false;
      if (!sectionPlan) {
        sectionCleanupPending = true;
      } else {
        await this.setAckState(
          sectionManifestId,
          JSON.stringify([.../* @__PURE__ */ new Set([...previousSections, ...sectionPlan.currentIds])].sort())
        );
        for (const [section, records] of sectionRecords) {
          const sectionBase = `${lessonsBase}.${section}`;
          await this.createResourceTree(
            "lessons",
            "not-updated",
            sectionBase,
            CHILD_LESSON_SECTION_NAMES[section]
          );
          const sectionNeedsCleanup = await this.commitCompleteResource("lessons", records, sectionBase);
          await this.setAckState(
            `${sectionBase}.status`,
            sectionNeedsCleanup ? "complete-cleanup-pending" : "complete"
          );
          await this.setAckState(`${sectionBase}.count`, records.length);
          await this.setAckState(`${sectionBase}.lastUpdate`, updatedAt);
          sectionCleanupPending || (sectionCleanupPending = sectionNeedsCleanup);
        }
        const failedSectionDeletions = [];
        for (const section of sectionPlan.staleIds) {
          try {
            await this.delObjectAsync(`${lessonsBase}.${section}`, { recursive: true });
          } catch {
            failedSectionDeletions.push(section);
          }
        }
        await this.setAckState(
          sectionManifestId,
          JSON.stringify([...sectionPlan.currentIds, ...failedSectionDeletions].sort())
        );
        sectionCleanupPending || (sectionCleanupPending = failedSectionDeletions.length > 0);
      }
      const childHasCleanupPending = childCleanupPending || sectionCleanupPending;
      cleanupPending || (cleanupPending = childHasCleanupPending);
      await this.setAckState(
        `${infoBase}.status`,
        childHasCleanupPending ? "complete-cleanup-pending" : "complete"
      );
      await this.setAckState(`${infoBase}.lastUpdate`, updatedAt);
    }
    const childIds = new Set(plan.currentIds);
    const nextPathMapping = /* @__PURE__ */ new Map();
    const nextPendingPaths = /* @__PURE__ */ new Map();
    const previousSourceIds = /* @__PURE__ */ new Set([
      ...previousIds,
      ...previousPaths.keys(),
      ...previousPendingPaths.keys(),
      ...plan.currentIds
    ]);
    for (const sourceId of previousSourceIds) {
      const currentPath = childPaths.get(sourceId);
      const oldPaths = new Set((_e = previousPendingPaths.get(sourceId)) != null ? _e : []);
      const mappedPath = previousPaths.get(sourceId);
      if (mappedPath) {
        oldPaths.add(mappedPath);
      } else if ((previousIds.includes(sourceId) || childIds.has(sourceId)) && await this.getObjectAsync(`${base}.${sourceId}`)) {
        oldPaths.add(sourceId);
      }
      const pendingForSource = [];
      for (const oldPath of oldPaths) {
        if (oldPath === currentPath || !await this.getObjectAsync(`${base}.${oldPath}`)) {
          continue;
        }
        const oldChildBase = `${base}.${oldPath}`;
        const alreadyPending = ((_f = previousPendingPaths.get(sourceId)) != null ? _f : []).includes(oldPath);
        const preserveTimetable = alreadyPending || await this.hasConfirmedTimetableData(`${oldChildBase}.timetable`);
        if (preserveTimetable) {
          pendingForSource.push(oldPath);
          for (const suffix of ["info", "lessons"]) {
            try {
              await this.delObjectAsync(`${oldChildBase}.${suffix}`, { recursive: true });
            } catch {
              cleanupPending = true;
            }
          }
          continue;
        }
        try {
          await this.delObjectAsync(oldChildBase, { recursive: true });
        } catch {
          pendingForSource.push(oldPath);
          cleanupPending = true;
        }
      }
      if (currentPath) {
        nextPathMapping.set(sourceId, currentPath);
      } else if (pendingForSource.length > 0) {
        nextPathMapping.set(sourceId, mappedPath != null ? mappedPath : pendingForSource[0]);
      }
      if (pendingForSource.length > 0) {
        nextPendingPaths.set(sourceId, [...new Set(pendingForSource)].sort());
      }
    }
    await this.writePendingChildTimetablePaths(nextPendingPaths);
    await this.writeChildPathMapping(nextPathMapping);
    await this.setAckState(manifestId, JSON.stringify(plan.currentIds));
    return cleanupPending || [...nextPendingPaths.keys()].some((sourceId) => !childIds.has(sourceId));
  }
  async commitRecordChannel(base, record, recordSegment, legacyObjectIds = [], compact = false, resource) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const channelId = `${base}.${recordSegment}`;
    const displayName = getReadableRecordName(record, true);
    const generatedDisplayName = resource === "timetable" && record.format === "html" && record.section === "own" ? displayName.replace(/^Personal timetable — /u, "") : displayName;
    const existing = await this.getObjectAsync(channelId);
    let objectName = generatedDisplayName;
    if (!existing) {
      for (const legacyObjectId of legacyObjectIds) {
        if (legacyObjectId === channelId) {
          continue;
        }
        const legacyObject = await this.getObjectAsync(legacyObjectId);
        const legacyPath = legacyObjectId.startsWith(`${base}.`) ? legacyObjectId.slice(base.length + 1) : "";
        const isReservedFixedObject = !legacyPath.includes(".") && getFixedResourceChildPaths(resource != null ? resource : "file-metadata", base).some(
          (path) => path.toLowerCase() === legacyPath.toLowerCase()
        );
        const hasRecordMetadata = typeof ((_a = legacyObject == null ? void 0 : legacyObject.native) == null ? void 0 : _a.portalRecordDisplayName) === "string" || Array.isArray((_b = legacyObject == null ? void 0 : legacyObject.native) == null ? void 0 : _b.portalRecordFieldIds);
        const legacyName = isReservedFixedObject && !hasRecordMetadata ? void 0 : (_c = legacyObject == null ? void 0 : legacyObject.common) == null ? void 0 : _c.name;
        if (typeof legacyName === "string" && legacyName !== ((_d = legacyObject == null ? void 0 : legacyObject.native) == null ? void 0 : _d.portalRecordDisplayName) && legacyName !== `Record ${record.id}`) {
          objectName = legacyName;
          break;
        }
      }
    }
    if (!existing) {
      await this.setObjectNotExistsAsync(channelId, {
        type: "channel",
        common: { name: objectName },
        native: { portalRecordDisplayName: generatedDisplayName, portalRecordFieldIds: [] }
      });
    }
    const existingName = (_e = existing == null ? void 0 : existing.common) == null ? void 0 : _e.name;
    const nameUpdate = existing ? (_g = (0, import_dynamic_record_sync.getGeneratedObjectNameUpdate)(
      existingName,
      (_f = existing.native) == null ? void 0 : _f.portalRecordDisplayName,
      generatedDisplayName
    )) != null ? _g : existingName === `Record ${record.id}` ? generatedDisplayName : null : null;
    const hasValidName = typeof existingName === "string" || typeof existingName === "object" && existingName !== null && !Array.isArray(existingName) && typeof existingName.en === "string" && Object.values(existingName).every((value) => typeof value === "string");
    await this.extendObjectAsync(channelId, {
      type: "channel",
      common: { name: nameUpdate != null ? nameUpdate : hasValidName ? existingName : objectName },
      native: { portalRecordDisplayName: generatedDisplayName }
    });
    let descriptors;
    if (compact) {
      const serializedRecord = JSON.stringify(record);
      if (typeof serializedRecord !== "string") {
        throw new Error("Invalid JSON record");
      }
      descriptors = [
        {
          id: "record_json",
          name: "Complete record (JSON)",
          value: serializedRecord,
          type: "string",
          role: "json"
        }
      ];
    } else {
      descriptors = getRecordFieldDescriptors(record, resource);
    }
    const previousFieldIds = Array.isArray((_h = existing == null ? void 0 : existing.native) == null ? void 0 : _h.portalRecordFieldIds) ? existing.native.portalRecordFieldIds.filter(
      (value) => typeof value === "string" && RECORD_ID_PATTERN.test(value)
    ) : [];
    const currentFieldIds = descriptors.map((field) => field.id);
    for (const descriptor of descriptors) {
      const previousId = descriptor.previousId;
      const legacyId = previousId && previousFieldIds.includes(previousId) && !currentFieldIds.includes(previousId) ? `${channelId}.${previousId}` : void 0;
      await this.commitRecordFieldState(`${channelId}.${descriptor.id}`, descriptor, legacyId);
    }
    const failedFieldDeletions = [];
    for (const fieldId of previousFieldIds) {
      if (currentFieldIds.includes(fieldId)) {
        continue;
      }
      try {
        await this.delObjectAsync(`${channelId}.${fieldId}`, { recursive: true });
      } catch {
        failedFieldDeletions.push(fieldId);
      }
    }
    await this.extendObjectAsync(channelId, {
      native: {
        portalRecordDisplayName: generatedDisplayName,
        portalRecordFieldIds: [.../* @__PURE__ */ new Set([...currentFieldIds, ...failedFieldDeletions])].sort()
      }
    });
    return failedFieldDeletions.length > 0;
  }
  async commitRecordFieldState(id, descriptor, legacyId) {
    var _a, _b;
    const existing = await this.getObjectAsync(id);
    if (!existing) {
      const legacy = legacyId ? await this.getObjectAsync(legacyId) : void 0;
      const previousName = (legacy == null ? void 0 : legacy.type) === "state" ? legacy.common.name : void 0;
      const previousGeneratedName = (_a = legacy == null ? void 0 : legacy.native) == null ? void 0 : _a.portalRecordFieldDisplayName;
      const name = previousName && typeof previousGeneratedName === "string" && previousName !== previousGeneratedName ? previousName : descriptor.name;
      await this.setObjectNotExistsAsync(id, {
        type: "state",
        common: {
          name,
          type: descriptor.type,
          role: descriptor.role,
          read: true,
          write: false
        },
        native: { portalRecordFieldDisplayName: descriptor.name }
      });
    } else {
      const nameUpdate = (0, import_dynamic_record_sync.getGeneratedObjectNameUpdate)(
        existing.common.name,
        (_b = existing.native) == null ? void 0 : _b.portalRecordFieldDisplayName,
        descriptor.name
      );
      await this.extendObjectAsync(id, {
        common: {
          ...nameUpdate ? { name: nameUpdate } : {},
          type: descriptor.type,
          role: descriptor.role,
          read: true,
          write: false
        },
        native: { portalRecordFieldDisplayName: descriptor.name }
      });
    }
    await this.setAckState(id, descriptor.value);
  }
  async cleanStaleRecordChannels(base, plan) {
    const failedDeletions = [];
    for (const id of plan.staleIds) {
      try {
        await this.delObjectAsync(`${base}.${id}`, { recursive: true });
      } catch {
        failedDeletions.push(id);
      }
    }
    await this.setAckState(`${base}.recordIds`, JSON.stringify([...plan.currentIds, ...failedDeletions].sort()));
    return failedDeletions.length > 0;
  }
  async cleanLegacyFieldsAtFixedPath(id, resource) {
    var _a;
    const fixed = await this.getObjectAsync(id);
    const tracked = (_a = fixed == null ? void 0 : fixed.native) == null ? void 0 : _a.portalRecordFieldIds;
    if ((fixed == null ? void 0 : fixed.type) !== "state" && (fixed == null ? void 0 : fixed.type) !== "channel" || !Array.isArray(tracked)) {
      return;
    }
    const protectedFields = fixed.type === "channel" ? new Set(getFixedResourceChildPaths(resource, id).map((path) => path.toLowerCase())) : void 0;
    await this.cleanTrackedRecordFields(id, tracked, protectedFields);
  }
  async cleanLegacyRecordAtCaseVariant(id) {
    var _a, _b;
    const channel = await this.getObjectAsync(id);
    const tracked = (_a = channel == null ? void 0 : channel.native) == null ? void 0 : _a.portalRecordFieldIds;
    if ((channel == null ? void 0 : channel.type) !== "channel" || channel._id !== `${this.namespace}.${id}` || typeof ((_b = channel.native) == null ? void 0 : _b.portalRecordDisplayName) !== "string" || !Array.isArray(tracked)) {
      return;
    }
    await this.cleanTrackedRecordFields(id, tracked);
    await this.delObjectAsync(id);
  }
  async cleanTrackedRecordFields(id, tracked, protectedFields) {
    var _a;
    for (const field of new Set(tracked)) {
      if (typeof field !== "string" || !RECORD_ID_PATTERN.test(field) || (protectedFields == null ? void 0 : protectedFields.has(field.toLowerCase()))) {
        continue;
      }
      const childId = `${id}.${field}`;
      const child = await this.getObjectAsync(childId);
      if ((child == null ? void 0 : child.type) === "state" && child._id === `${this.namespace}.${childId}` && typeof ((_a = child.native) == null ? void 0 : _a.portalRecordFieldDisplayName) === "string") {
        await this.delObjectAsync(childId);
      }
    }
  }
  async commitCompleteResource(resource, records, base = getResourceBase(resource)) {
    var _a, _b, _c, _d, _e, _f;
    const manifestId = `${base}.recordIds`;
    const previousIds = await this.readRecordManifest(manifestId);
    const previousPaths = await this.readRecordPathMapping(base);
    const pathEntries = records.map((record) => ({
      sourceId: (0, import_dynamic_record_sync.toSafeDynamicRecordId)(record.id),
      displayName: getReadableRecordPathName(resource, record)
    }));
    const plan = (0, import_dynamic_record_sync.planDynamicRecordSync)(
      previousIds,
      pathEntries.map((entry) => entry.sourceId),
      true
    );
    if (!plan) {
      return false;
    }
    const reservedDailyDates = resource === "substitutions" ? /* @__PURE__ */ new Set([
      ...await this.readDailySubstitutionDates(`${base}.dailyJsonDates`),
      ...groupDailySubstitutionRows(records).keys()
    ]) : /* @__PURE__ */ new Set();
    const fixedResourcePaths = new Set(getFixedResourceChildPaths(resource, base));
    const normalizedFixedPaths = new Set([...fixedResourcePaths].map((path) => path.toLowerCase()));
    const reservedFixedPaths = /* @__PURE__ */ new Set([...normalizedFixedPaths, ...reservedDailyDates]);
    const pathReservations = [...reservedFixedPaths].map((path, index) => ({
      ownerId: `fixed:${index}:${path}`,
      path,
      fixed: true
    }));
    for (const sourceId of /* @__PURE__ */ new Set([...previousIds, ...previousPaths.keys()])) {
      const paths = (_a = previousPaths.get(sourceId)) != null ? _a : [sourceId];
      for (const path of paths) {
        if (await this.getObjectAsync(`${base}.${path}`)) {
          pathReservations.push({ ownerId: sourceId, path });
        }
      }
    }
    const currentPaths = resource === "substitutions" ? getSubstitutionRecordPaths(records) : allocateSegmentsWithReservations(pathEntries, pathReservations);
    const currentSegments = new Set([...currentPaths.values()].map((path) => path.toLowerCase()));
    const dataJson = JSON.stringify(records);
    if (typeof dataJson !== "string") {
      throw new Error("Invalid JSON data");
    }
    if (resource === "substitutions") {
      const parentChannels = new Set([...currentPaths.values()].map((path) => path.split(".")[0]));
      for (const parentChannel of parentChannels) {
        await this.ensureChannel(
          `${base}.${parentChannel}`,
          parentChannel === "undated" ? "Undated substitutions" : parentChannel
        );
      }
    }
    await this.setAckState(manifestId, JSON.stringify([.../* @__PURE__ */ new Set([...previousIds, ...plan.currentIds])].sort()));
    let cleanupPending = false;
    for (const record of records) {
      if (typeof JSON.stringify(record) !== "string") {
        throw new Error("Invalid JSON record");
      }
      const sourceId = (0, import_dynamic_record_sync.toSafeDynamicRecordId)(record.id);
      const recordPath = currentPaths.get(sourceId);
      if (!recordPath) {
        throw new Error("Missing readable record path");
      }
      const legacyObjectIds = [
        `${base}.${sourceId}`,
        ...((_b = previousPaths.get(sourceId)) != null ? _b : []).map((path) => `${base}.${path}`),
        `${base}.records.${sourceId}`
      ];
      cleanupPending = await this.commitRecordChannel(
        base,
        record,
        recordPath,
        [...new Set(legacyObjectIds)],
        isCompactRecordResource(resource),
        resource
      ) || cleanupPending;
    }
    if (resource === "substitutions") {
      cleanupPending = await this.commitDailySubstitutionJson(records) || cleanupPending;
    }
    await this.setAckState(`${base}.json`, dataJson);
    if (resource === "messages") {
      await this.setAckState(`${base}.unreadCount`, this.getUnreadMessageCount(records));
    }
    const pathsToRemove = /* @__PURE__ */ new Map();
    const sourceIds = /* @__PURE__ */ new Set([...previousIds, ...previousPaths.keys()]);
    for (const sourceId of sourceIds) {
      const currentPath = currentPaths.get(sourceId);
      const oldPaths = new Set((_c = previousPaths.get(sourceId)) != null ? _c : []);
      if ((previousIds.includes(sourceId) || previousPaths.has(sourceId)) && sourceId !== currentPath) {
        oldPaths.add(sourceId);
      }
      for (const oldPath of oldPaths) {
        const normalizedOldPath = oldPath.toLowerCase();
        const [root, child] = normalizedOldPath.split(".");
        if (currentSegments.has(normalizedOldPath) || child && (normalizedFixedPaths.has(root) || currentSegments.has(root) || currentSegments.has(`${root}.${child}`)) || resource === "substitutions" && (root === "undated" && !child || reservedDailyDates.has(root) && (!child || child === "json"))) {
          continue;
        }
        try {
          const id = `${base}.${oldPath}`;
          if (fixedResourcePaths.has(oldPath)) {
            if (oldPath !== "records") {
              await this.cleanLegacyFieldsAtFixedPath(id, resource);
            }
          } else if (normalizedFixedPaths.has(normalizedOldPath)) {
            if (((_d = previousPaths.get(sourceId)) == null ? void 0 : _d.includes(oldPath)) || previousIds.includes(sourceId)) {
              await this.cleanLegacyRecordAtCaseVariant(id);
            }
          } else {
            await this.delObjectAsync(id, { recursive: true });
          }
        } catch {
          cleanupPending = true;
          const failedPaths = (_e = pathsToRemove.get(sourceId)) != null ? _e : /* @__PURE__ */ new Set();
          failedPaths.add(oldPath);
          pathsToRemove.set(sourceId, failedPaths);
        }
      }
    }
    if (!currentSegments.has("records")) {
      try {
        await this.delObjectAsync(`${base}.records`, { recursive: true });
      } catch {
        cleanupPending = true;
      }
    }
    const nextPaths = /* @__PURE__ */ new Map();
    for (const [sourceId, path] of currentPaths) {
      nextPaths.set(sourceId, [path, ...(_f = pathsToRemove.get(sourceId)) != null ? _f : []]);
    }
    for (const [sourceId, paths] of pathsToRemove) {
      if (!currentPaths.has(sourceId)) {
        nextPaths.set(sourceId, [...paths]);
      }
    }
    const staleIdsPendingCleanup = [...pathsToRemove.keys()].filter((sourceId) => !currentPaths.has(sourceId));
    await this.writeRecordPathMapping(base, nextPaths);
    await this.setAckState(
      manifestId,
      JSON.stringify([.../* @__PURE__ */ new Set([...plan.currentIds, ...staleIdsPendingCleanup])].sort())
    );
    return cleanupPending;
  }
  async commitDailySubstitutionJson(records) {
    const base = getResourceBase("substitutions");
    const manifestId = `${base}.dailyJsonDates`;
    const previousDates = await this.readDailySubstitutionDates(manifestId);
    const groups = groupDailySubstitutionRows(records);
    const currentDates = [...groups.keys()].sort();
    for (const date of currentDates) {
      const channelId = `${base}.${date}`;
      await this.ensureChannel(channelId, date);
      const stateId = `${channelId}.json`;
      await this.ensureState(stateId, `Substitutions for ${date} (JSON)`, "string", "json", "[]");
      const dataJson = JSON.stringify(groups.get(date));
      if (typeof dataJson !== "string") {
        throw new Error("Invalid daily substitution JSON");
      }
      await this.setAckState(stateId, dataJson);
    }
    const currentDateSet = new Set(currentDates);
    const failedDeletions = [];
    for (const date of previousDates) {
      if (currentDateSet.has(date)) {
        continue;
      }
      try {
        await this.delObjectAsync(`${base}.${date}`, { recursive: true });
      } catch {
        failedDeletions.push(date);
      }
    }
    await this.setAckState(manifestId, JSON.stringify([.../* @__PURE__ */ new Set([...currentDates, ...failedDeletions])].sort()));
    return failedDeletions.length > 0;
  }
  async readDailySubstitutionDates(id) {
    const state = await this.getStateAsync(id);
    if (typeof (state == null ? void 0 : state.val) !== "string") {
      return [];
    }
    try {
      const value = JSON.parse(state.val);
      return Array.isArray(value) ? [
        ...new Set(
          value.filter((date) => typeof date === "string" && isIsoCalendarDate(date))
        )
      ].sort() : [];
    } catch {
      return [];
    }
  }
  async readRecordManifest(id) {
    const state = await this.getStateAsync(id);
    if (typeof (state == null ? void 0 : state.val) !== "string") {
      return [];
    }
    try {
      const value = JSON.parse(state.val);
      return Array.isArray(value) ? value.filter((item) => typeof item === "string" && RECORD_ID_PATTERN.test(item)) : [];
    } catch {
      return [];
    }
  }
  responseStatus(classification) {
    var _a;
    const statuses = {
      forbidden: "permission-denied",
      "not-found": "not-available",
      "rate-limited": "rate-limited",
      "session-expired": "authentication-failed",
      "response-too-large": "response-too-large",
      "blocked-redirect": "blocked-redirect",
      "redirect-limit": "redirect-limit",
      "client-error": "request-error",
      "server-error": "server-error",
      redirect: "redirect",
      unknown: "unknown-response"
    };
    return (_a = statuses[classification]) != null ? _a : "request-error";
  }
  isExpectedUnavailable(status) {
    return status === "unavailable" || status === "permission-denied" || status === "feature-unavailable" || status === "not-available";
  }
  async onUnload(callback) {
    this.unloading = true;
    this.cancelRefreshTimer();
    for (const session of this.activeSessions) {
      session.close();
    }
    try {
      await this.activeRefresh;
    } catch {
      this.log.debug("An in-progress refresh ended during shutdown.");
    } finally {
      callback();
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  SchulportalHessenAdapter
});
//# sourceMappingURL=adapter.js.map
