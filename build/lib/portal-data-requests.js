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
var portal_data_requests_exports = {};
__export(portal_data_requests_exports, {
  createPortalResourceRequests: () => createPortalResourceRequests
});
module.exports = __toCommonJS(portal_data_requests_exports);
var import_node_crypto = require("node:crypto");
var import_portal_parser = require("./portal-parser");
function createPortalResourceRequests(reader, dateWindow, now = Date.now()) {
  return [
    { id: "account", read: () => reader.get("/benutzerverwaltung.php?a=userData") },
    { id: "substitutions", read: () => readSubstitutions(reader) },
    {
      id: "calendar",
      read: () => reader.postRead({
        type: "calendar-events",
        start: dateWindow.calendarStart,
        end: dateWindow.calendarEnd
      })
    },
    { id: "school-calendar", read: () => readSchoolCalendar(reader, dateWindow.schoolYearStart) },
    {
      id: "lessons",
      read: () => readLessons(reader, Math.trunc(now)),
      parse: (body, contentType) => parseAggregateRecords("lessons", body, contentType)
    },
    {
      id: "timetable",
      read: () => readTimetables(reader),
      parse: parseTimetableAggregation
    },
    { id: "learning-groups", read: () => reader.get("/lerngruppen.php") },
    { id: "messages", read: () => readMessages(reader) },
    {
      id: "file-metadata",
      read: () => readFileMetadata(reader),
      parse: (body, contentType) => parseAggregateRecords("file-metadata", body, contentType)
    }
  ];
}
const MAX_LESSON_DETAIL_READS = 20;
const MAX_TIMETABLE_DETAIL_READS = 20;
const MAX_MESSAGE_DETAIL_READS = 20;
const MAX_FILE_FOLDER_READS = 100;
const MAX_AGGREGATED_BYTES = 4 * 1024 * 1024;
async function readMessages(reader) {
  var _a, _b, _c, _d, _e;
  const headers = await reader.postRead({ type: "message-headers" });
  if (headers.classification !== "success") {
    return headers;
  }
  try {
    const parsedHeaders = (0, import_portal_parser.parsePortalResource)(
      "messages",
      Buffer.from(headers.body).toString("utf8"),
      (_a = headers.contentType) != null ? _a : void 0
    );
    if (parsedHeaders.status !== "complete") {
      return incompleteAggregation("message-headers-invalid");
    }
    let aggregatedPayloadBytes = (_b = headers.bodyByteLength) != null ? _b : headers.body.byteLength;
    if (!Number.isSafeInteger(aggregatedPayloadBytes) || aggregatedPayloadBytes < 0 || aggregatedPayloadBytes > MAX_AGGREGATED_BYTES) {
      return incompleteAggregation("message-aggregation-limit-exceeded");
    }
    const visibleRecords = [];
    for (const record of parsedHeaders.records) {
      if (record.format !== "json" || !isRecord(record.fields) || typeof record.fields.id !== "string" || !/^[a-f0-9]{64}$/u.test(record.fields.id)) {
        return incompleteAggregation("message-headers-invalid");
      }
      if (record.fields.hidden === true) {
        continue;
      }
      if (record.fields.hidden !== false || typeof record.fields.unread !== "boolean") {
        return incompleteAggregation("message-header-metadata-unverified");
      }
      visibleRecords.push({ record, fields: { ...record.fields }, idHash: record.fields.id });
    }
    if (visibleRecords.length > MAX_MESSAGE_DETAIL_READS) {
      return incompleteAggregation("message-detail-limit-exceeded");
    }
    const records = [];
    let detailIndex = 0;
    for (const record of parsedHeaders.records) {
      if (record.format !== "json" || !isRecord(record.fields)) {
        return incompleteAggregation("message-headers-invalid");
      }
      if (record.fields.hidden === true) {
        records.push(record);
      } else {
        const visible = visibleRecords[detailIndex++];
        if (!visible) {
          return incompleteAggregation("message-headers-invalid");
        }
        const detailResponse = await reader.postRead({ type: "message-detail", messageIdHash: visible.idHash });
        if (detailResponse.classification !== "success") {
          return detailResponse.classification === "unknown" ? { ...detailResponse, diagnosticCode: "message-detail-response-unknown" } : detailResponse;
        }
        const detailBytes = (_c = detailResponse.bodyByteLength) != null ? _c : detailResponse.body.byteLength;
        if (!Number.isSafeInteger(detailBytes) || detailBytes < 0 || detailBytes > MAX_AGGREGATED_BYTES - aggregatedPayloadBytes) {
          return incompleteAggregation("message-aggregation-limit-exceeded");
        }
        aggregatedPayloadBytes += detailBytes;
        const detail = parseMessageDetail(detailResponse.body, visible.idHash);
        if (!detail) {
          return incompleteAggregation("message-detail-invalid");
        }
        const fields = {
          ...visible.fields,
          ...detail,
          date: (_d = visible.fields.date) != null ? _d : detail.date
        };
        records.push({ format: "json", id: visible.record.id, fields });
      }
      if (!fitsAggregationLimit(records)) {
        return incompleteAggregation("message-aggregation-limit-exceeded");
      }
    }
    return aggregatedMessageResponse(records);
  } finally {
    (_e = reader.discardMessageSourceIds) == null ? void 0 : _e.call(reader);
  }
}
function aggregatedMessageResponse(records) {
  const fields = records.map((record) => record.format === "json" ? record.fields : {});
  return {
    status: 200,
    classification: "success",
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(fields), "utf8")
  };
}
function isSafeMessageText(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength && !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== void 0 && (codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13 || codePoint >= 127 && codePoint <= 159);
  });
}
function parseMessageDetail(body, expectedIdHash) {
  if (body.byteLength > MAX_AGGREGATED_BYTES) {
    return null;
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const expectedKeys = /* @__PURE__ */ new Set([
    "id",
    "date",
    "username",
    "own",
    "content",
    "replies",
    "time",
    "groupChat",
    "onlyPrivateAnswers",
    "noReply",
    "participantCounts"
  ]);
  const participantCounts = value.participantCounts;
  if (!isRecord(participantCounts)) {
    return null;
  }
  if (Object.keys(value).some((key) => !expectedKeys.has(key)) || value.id !== expectedIdHash || !isSafeMessageText(value.date, 8192) || !isSafeMessageText(value.username, 8192) || typeof value.own !== "boolean" || !isSafeMessageText(value.content, MAX_AGGREGATED_BYTES) || !Array.isArray(value.replies) || value.replies.length > 100 || !Number.isSafeInteger(value.time) || value.time < 0 || typeof value.groupChat !== "boolean" || typeof value.onlyPrivateAnswers !== "boolean" || typeof value.noReply !== "boolean" || !["students", "teachers", "parents"].every(
    (key) => Number.isSafeInteger(participantCounts[key]) && participantCounts[key] >= 0
  )) {
    return null;
  }
  for (const reply of value.replies) {
    if (!isRecord(reply) || Object.keys(reply).some((key) => !["id", "date", "username", "own", "content"].includes(key)) || typeof reply.id !== "string" || !/^[a-f0-9]{64}$/u.test(reply.id) || !isSafeMessageText(reply.date, 8192) || !isSafeMessageText(reply.username, 8192) || typeof reply.own !== "boolean" || !isSafeMessageText(reply.content, MAX_AGGREGATED_BYTES)) {
      return null;
    }
  }
  return {
    date: value.date,
    username: value.username,
    own: value.own,
    content: value.content,
    replies: value.replies,
    time: value.time,
    groupChat: value.groupChat,
    onlyPrivateAnswers: value.onlyPrivateAnswers,
    noReply: value.noReply,
    participantCounts: value.participantCounts
  };
}
const TIMETABLE_WEEKDAY_HEADER_IDS = {
  monday: "monday",
  mon: "monday",
  montag: "monday",
  mo: "monday",
  tuesday: "tuesday",
  tue: "tuesday",
  tues: "tuesday",
  dienstag: "tuesday",
  di: "tuesday",
  wednesday: "wednesday",
  wed: "wednesday",
  mittwoch: "wednesday",
  mi: "wednesday",
  thursday: "thursday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  donnerstag: "thursday",
  do: "thursday",
  friday: "friday",
  fri: "friday",
  freitag: "friday",
  fr: "friday",
  saturday: "saturday",
  sat: "saturday",
  samstag: "saturday",
  sa: "saturday",
  sunday: "sunday",
  sun: "sunday",
  sonntag: "sunday",
  so: "sunday"
};
function getTimetableWeekdayColumns(headers) {
  var _a, _b, _c, _d;
  if (headers.length !== 1) {
    return null;
  }
  const headerRow = headers[0];
  if (!headerRow || headerRow.length < 3) {
    return null;
  }
  const normalizeWeekdayHeader = (value) => {
    var _a2;
    const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("en-US").replace(/ß/gu, "ss").replace(/\./gu, "").trim();
    return Object.hasOwn(TIMETABLE_WEEKDAY_HEADER_IDS, normalized) ? (_a2 = TIMETABLE_WEEKDAY_HEADER_IDS[normalized]) != null ? _a2 : null : null;
  };
  if (normalizeWeekdayHeader((_b = (_a = headerRow[0]) == null ? void 0 : _a.text) != null ? _b : "") !== null) {
    return null;
  }
  const seen = /* @__PURE__ */ new Set();
  const columns = [];
  for (let index = 1; index < headerRow.length; index++) {
    const weekday = normalizeWeekdayHeader((_d = (_c = headerRow[index]) == null ? void 0 : _c.text) != null ? _d : "");
    if (!weekday || seen.has(weekday)) {
      return null;
    }
    seen.add(weekday);
    columns.push({ index, weekday });
  }
  return columns.length >= 2 ? columns : null;
}
function getTableSpan(field, attribute, columnCount) {
  const value = field.attributes[attribute];
  if (value === void 0) {
    return 1;
  }
  if (!/^\d+$/u.test(value)) {
    return null;
  }
  const span = Number(value);
  return Number.isSafeInteger(span) && span > 0 && span <= columnCount ? span : null;
}
function normalizeTimetableGridText(value) {
  return value.replace(/\s+/gu, " ").trim();
}
function getTimetablePeriodTimes(value) {
  var _a, _b;
  if (((_a = value.match(/\d{1,2}:\d{2}/gu)) != null ? _a : []).length !== 2) {
    return null;
  }
  const ranges = [
    ...value.matchAll(
      /(?:^|[^\d:])((?:[01]?\d|2[0-3]):[0-5]\d)\s*[-–—]\s*((?:[01]?\d|2[0-3]):[0-5]\d)(?=$|[^\d:])/gu
    )
  ];
  if (ranges.length !== 1 || !((_b = ranges[0]) == null ? void 0 : _b[1]) || !ranges[0][2]) {
    return null;
  }
  const [startHour, startMinute] = ranges[0][1].split(":").map(Number);
  const [endHour, endMinute] = ranges[0][2].split(":").map(Number);
  if (startHour === void 0 || startMinute === void 0 || endHour === void 0 || endMinute === void 0 || startHour * 60 + startMinute >= endHour * 60 + endMinute) {
    return null;
  }
  return {
    startTime: `${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}`,
    endTime: `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`
  };
}
function getTimetableGridRows(group, recordsById) {
  var _a, _b;
  const columnCount = (_b = (_a = group.headers[0]) == null ? void 0 : _a.length) != null ? _b : 0;
  if (columnCount === 0) {
    return null;
  }
  let activeRowspans = /* @__PURE__ */ new Map();
  const rows = [];
  for (const recordId of group.recordIds) {
    const record = recordsById.get(recordId);
    if (!record || record.format !== "html") {
      return null;
    }
    const cells = Array.from({ length: columnCount });
    const nextRowspans = /* @__PURE__ */ new Map();
    for (const [column, rowspan] of activeRowspans) {
      cells[column] = rowspan.cell;
      if (rowspan.remaining > 1) {
        nextRowspans.set(column, { cell: rowspan.cell, remaining: rowspan.remaining - 1 });
      }
    }
    let fieldIndex = 0;
    for (let column = 0; column < columnCount; column++) {
      if (cells[column]) {
        continue;
      }
      const field = record.fields[fieldIndex++];
      if (!field) {
        return null;
      }
      const colspan = getTableSpan(field, "colspan", columnCount);
      const rowspan = getTableSpan(field, "rowspan", columnCount);
      if (colspan === null || rowspan === null || column + colspan > columnCount) {
        return null;
      }
      for (let offset = 0; offset < colspan; offset++) {
        const targetColumn = column + offset;
        if (cells[targetColumn]) {
          return null;
        }
        cells[targetColumn] = field;
        if (rowspan > 1) {
          if (nextRowspans.has(targetColumn)) {
            return null;
          }
          nextRowspans.set(targetColumn, { cell: field, remaining: rowspan - 1 });
        }
      }
      column += colspan - 1;
    }
    if (fieldIndex !== record.fields.length || cells.some((cell) => cell === void 0)) {
      return null;
    }
    rows.push({ record, cells });
    activeRowspans = nextRowspans;
  }
  return activeRowspans.size === 0 ? rows : null;
}
async function readTimetables(reader) {
  var _a, _b, _c, _d;
  const listing = await reader.get("/stundenplan.php");
  if (listing.classification !== "success") {
    return listing;
  }
  const parsedListing = (0, import_portal_parser.parsePortalResource)(
    "timetable",
    Buffer.from(listing.body).toString("utf8"),
    (_a = listing.contentType) != null ? _a : void 0
  );
  if (parsedListing.status !== "complete" || !parsedListing.timetableChildren) {
    return listing;
  }
  const links = parsedListing.timetableChildren;
  if (links.length > MAX_TIMETABLE_DETAIL_READS) {
    return incompleteAggregation("timetable-child-limit-exceeded");
  }
  const seenChildIds = /* @__PURE__ */ new Set();
  const childTimetables = [];
  for (const link of links) {
    if (!/^[a-f0-9]{64}$/u.test(link.id) || !/^\/stundenplan\.php\?e=1&a=detail_klasse&k=[A-Za-z0-9_-]{1,32}&p=[0-9]{1,20}$/u.test(link.requestPath) || seenChildIds.has(link.id)) {
      return incompleteAggregation("timetable-child-link-invalid");
    }
    seenChildIds.add(link.id);
    const response = await reader.get(link.requestPath);
    if (response.classification !== "success") {
      return response.classification === "unknown" ? { ...response, diagnosticCode: "timetable-child-response-unknown" } : response;
    }
    const parsedDetail = (0, import_portal_parser.parsePortalTimetableChildDetail)(
      Buffer.from(response.body).toString("utf8"),
      (_b = response.contentType) != null ? _b : void 0
    );
    if (parsedDetail.status !== "complete") {
      return incompleteAggregation(`timetable-child-detail-${parsedDetail.status}-${parsedDetail.reason}`);
    }
    if (parsedDetail.timetableChildren !== void 0) {
      return incompleteAggregation("timetable-child-detail-unexpected-index");
    }
    const ownGroups = parsedDetail.groups.filter((group) => group.section === "own");
    if (ownGroups.length === 0) {
      return incompleteAggregation("timetable-child-own-section-missing");
    }
    const ownRecordIds = new Set(ownGroups.flatMap((group) => group.recordIds));
    const sourceOwnRecords = parsedDetail.records.filter((record) => ownRecordIds.has(record.id));
    if (sourceOwnRecords.length !== ownRecordIds.size || sourceOwnRecords.some((record) => record.format !== "html" || record.section !== "own")) {
      return incompleteAggregation("timetable-child-own-records-invalid");
    }
    const sourceRecordsById = new Map(sourceOwnRecords.map((record) => [record.id, record]));
    const ownRecords = [];
    for (const group of ownGroups) {
      const weekdayColumns = getTimetableWeekdayColumns(group.headers);
      if (!weekdayColumns) {
        for (const recordId of group.recordIds) {
          const record = sourceRecordsById.get(recordId);
          if (!record || record.format !== "html") {
            return incompleteAggregation("timetable-child-own-records-invalid");
          }
          ownRecords.push(record);
        }
        continue;
      }
      const gridRows = getTimetableGridRows(group, sourceRecordsById);
      const periodHeader = ((_d = (_c = group.headers[0]) == null ? void 0 : _c[0]) == null ? void 0 : _d.text.trim()) || "Period";
      if (!gridRows) {
        return incompleteAggregation("timetable-child-weekday-grid-invalid");
      }
      for (const { record, cells } of gridRows) {
        const periodField = cells[0];
        if (!periodField) {
          return incompleteAggregation("timetable-child-weekday-grid-invalid");
        }
        const periodText = normalizeTimetableGridText(periodField.text);
        const periodTimes = getTimetablePeriodTimes(periodField.text);
        const timeFields = periodTimes ? [
          { header: "Start time", text: periodTimes.startTime, links: [], attributes: {} },
          { header: "End time", text: periodTimes.endTime, links: [], attributes: {} }
        ] : [];
        for (const { index, weekday } of weekdayColumns) {
          const lessonField = cells[index];
          if (!lessonField) {
            return incompleteAggregation("timetable-child-weekday-grid-invalid");
          }
          const lessonText = normalizeTimetableGridText(lessonField.text);
          if (!lessonText) {
            continue;
          }
          ownRecords.push({
            ...record,
            id: `${record.id}:${weekday}`,
            fields: [
              { ...periodField, header: periodHeader, text: periodText },
              { ...lessonField, header: "Lesson", text: lessonText },
              ...timeFields
            ],
            context: { ...record.context, timetableWeekday: weekday }
          });
        }
      }
    }
    childTimetables.push({
      id: link.id,
      records: ownRecords.map((record) => ({
        ...record,
        id: hashAggregateId(`timetable-child:${link.id}`, record.id),
        context: { ...record.context, childId: link.id }
      }))
    });
    if (!fitsChildTimetableAggregationLimit(childTimetables)) {
      return incompleteAggregation("timetable-aggregation-limit-exceeded");
    }
  }
  return aggregatedChildTimetablesResponse(childTimetables);
}
function parseTimetableAggregation(body, contentType) {
  const source = Buffer.from(body).toString("utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return (0, import_portal_parser.parsePortalResource)("timetable", source, contentType != null ? contentType : void 0);
  }
  if (!isRecord(value) || !Array.isArray(value.childTimetables)) {
    return (0, import_portal_parser.parsePortalResource)("timetable", source, contentType != null ? contentType : void 0);
  }
  const childIds = /* @__PURE__ */ new Set();
  const children = [];
  for (const child of value.childTimetables) {
    if (!isRecord(child) || typeof child.id !== "string" || !/^[a-f0-9]{64}$/u.test(child.id) || !Array.isArray(child.records) || !child.records.every(isPortalRecord) || childIds.has(child.id) || child.records.some(
      (record) => record.format !== "html" || record.section !== "own" || !isRecord(record.context) || record.context.childId !== child.id
    )) {
      return { status: "invalid", kind: "timetable", reason: "invalid-json-records" };
    }
    childIds.add(child.id);
    children.push({ id: child.id, records: child.records });
  }
  const records = children.flatMap((child) => child.records);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    return { status: "invalid", kind: "timetable", reason: "invalid-json-records" };
  }
  return { status: "complete", kind: "timetable", records, groups: [], childTimetables: children };
}
async function readLessons(reader, now) {
  var _a, _b;
  const listing = await reader.get(`/meinunterricht.php?cacheBreaker=${now}`);
  if (listing.classification !== "success") {
    return listing;
  }
  const parsedListing = (0, import_portal_parser.parsePortalResource)(
    "lessons",
    Buffer.from(listing.body).toString("utf8"),
    (_a = listing.contentType) != null ? _a : void 0
  );
  if (parsedListing.status !== "complete") {
    return listing;
  }
  if (parsedListing.children) {
    return readParentLessons(reader, parsedListing.children);
  }
  const courseIds = [
    ...new Set(
      parsedListing.records.flatMap(
        (record) => record.format === "html" && record.courseId ? [record.courseId] : []
      )
    )
  ];
  if (courseIds.length === 0) {
    return listing;
  }
  if (courseIds.length > MAX_LESSON_DETAIL_READS) {
    return incompleteAggregation();
  }
  const records = [...parsedListing.records];
  if (!fitsAggregationLimit(records)) {
    return incompleteAggregation();
  }
  for (const courseId of courseIds) {
    const response = await reader.get(`/meinunterricht.php?a=view&id=${courseId}`);
    if (response.classification !== "success") {
      return response;
    }
    const parsedDetails = (0, import_portal_parser.parsePortalResource)(
      "lessons",
      Buffer.from(response.body).toString("utf8"),
      (_b = response.contentType) != null ? _b : void 0
    );
    if (parsedDetails.status !== "complete") {
      return incompleteAggregation();
    }
    for (const record of parsedDetails.records) {
      records.push({
        ...record,
        id: hashAggregateId(`lesson:${courseId}`, record.id),
        context: { courseId }
      });
    }
    if (!fitsAggregationLimit(records)) {
      return incompleteAggregation();
    }
  }
  return aggregatedResponse(records);
}
function childLessonSectionForPortalSection(section) {
  switch (section) {
    case "current":
    case "aktuell":
      return "current";
    case "mappen":
    case "assignments":
      return "assignments";
    case "history":
      return "history";
    case "attendanceTable":
    case "anwesend":
    case "attendance":
      return "attendance";
    case "marks":
      return "marks";
    case "klausuren":
    case "exams":
      return "exams";
    default:
      return "other";
  }
}
async function readParentLessons(reader, listingChildren) {
  var _a;
  const children = listingChildren.map((child) => {
    var _a2;
    return {
      ...child,
      records: [...child.records],
      sections: [...(_a2 = child.sections) != null ? _a2 : []]
    };
  });
  const courseIdsByChild = listingChildren.map((child) => [
    ...new Set(
      child.records.flatMap((record) => record.format === "html" && record.courseId ? [record.courseId] : [])
    )
  ]);
  if (courseIdsByChild.reduce((total, courseIds) => total + courseIds.length, 0) > MAX_LESSON_DETAIL_READS || !fitsParentAggregationLimit(children)) {
    return incompleteAggregation();
  }
  for (const [index, courseIds] of courseIdsByChild.entries()) {
    const child = children[index];
    if (!child) {
      return incompleteAggregation();
    }
    for (const courseId of courseIds) {
      const response = await reader.get(`/meinunterricht.php?a=view&id=${courseId}`);
      if (response.classification !== "success") {
        return response;
      }
      const parsedDetails = (0, import_portal_parser.parsePortalResource)(
        "lessons",
        Buffer.from(response.body).toString("utf8"),
        (_a = response.contentType) != null ? _a : void 0
      );
      if (parsedDetails.status !== "complete" || parsedDetails.children !== void 0) {
        return incompleteAggregation();
      }
      const sections = new Set(child.sections);
      for (const group of parsedDetails.groups) {
        sections.add(childLessonSectionForPortalSection(group.section));
      }
      child.sections = [...sections];
      for (const record of parsedDetails.records) {
        child.records.push({
          ...record,
          id: hashAggregateId(`lesson-child:${child.id}:course:${courseId}`, record.id),
          context: { ...record.context, childId: child.id, courseId }
        });
      }
      if (!fitsParentAggregationLimit(children)) {
        return incompleteAggregation();
      }
    }
  }
  return aggregatedLessonsResponse(children);
}
async function readFileMetadata(reader) {
  var _a;
  const records = [];
  const pendingFolderIds = ["0"];
  const visitedFolderIds = new Set(pendingFolderIds);
  const recordIds = /* @__PURE__ */ new Set();
  let reads = 0;
  while (pendingFolderIds.length > 0) {
    if (reads >= MAX_FILE_FOLDER_READS) {
      return incompleteAggregation();
    }
    const folderId = pendingFolderIds.shift();
    if (!folderId) {
      return incompleteAggregation();
    }
    const response = folderId === "0" ? await reader.get("/dateispeicher.php?a=view&folder=0") : await reader.get(`/dateispeicher.php?a=view&folder=${folderId}`);
    reads++;
    if (response.classification !== "success") {
      return response;
    }
    const parsedFolder = (0, import_portal_parser.parsePortalResource)(
      "file-metadata",
      Buffer.from(response.body).toString("utf8"),
      (_a = response.contentType) != null ? _a : void 0
    );
    if (parsedFolder.status !== "complete") {
      return folderId === "0" ? response : incompleteAggregation();
    }
    for (const record of parsedFolder.records) {
      if (record.format !== "json" || !isRecord(record.fields)) {
        return incompleteAggregation();
      }
      if (record.fields.recordType === "folder") {
        const childFolderId = record.fields.folderId;
        if (typeof childFolderId !== "string" || !/^\d{1,20}$/u.test(childFolderId)) {
          return incompleteAggregation();
        }
        if (!recordIds.has(record.id)) {
          recordIds.add(record.id);
          records.push({ ...record, context: { parentFolderId: folderId } });
        }
        if (!visitedFolderIds.has(childFolderId)) {
          visitedFolderIds.add(childFolderId);
          pendingFolderIds.push(childFolderId);
        }
      } else if (record.fields.recordType === "file") {
        const fileId = record.fields.fileId;
        const enrichedRecord = {
          ...record,
          id: hashAggregateId(`file:${folderId}`, typeof fileId === "string" ? fileId : record.id),
          context: { parentFolderId: folderId }
        };
        if (recordIds.has(enrichedRecord.id)) {
          return incompleteAggregation();
        }
        recordIds.add(enrichedRecord.id);
        records.push(enrichedRecord);
      } else {
        return incompleteAggregation();
      }
    }
    if (!fitsAggregationLimit(records)) {
      return incompleteAggregation();
    }
  }
  return aggregatedResponse(records);
}
function parseAggregateRecords(kind, body, contentType) {
  const source = Buffer.from(body).toString("utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return (0, import_portal_parser.parsePortalResource)(kind, source, contentType != null ? contentType : void 0);
  }
  if (kind === "lessons" && isRecord(value)) {
    return parseParentLessonEnvelope(value);
  }
  if (!Array.isArray(value) || !value.every(isPortalRecord)) {
    return (0, import_portal_parser.parsePortalResource)(kind, source, contentType != null ? contentType : void 0);
  }
  const ids = value.map((record) => record.id);
  if (new Set(ids).size !== ids.length) {
    return { status: "invalid", kind, reason: "invalid-json-records" };
  }
  return { status: "complete", kind, records: value, groups: [] };
}
function parseParentLessonEnvelope(value) {
  if (!Array.isArray(value.children)) {
    return { status: "invalid", kind: "lessons", reason: "invalid-json-records" };
  }
  const childIds = /* @__PURE__ */ new Set();
  const children = [];
  for (const child of value.children) {
    if (!isRecord(child) || typeof child.id !== "string" || !/^[a-f0-9]{64}$/u.test(child.id) || typeof child.name !== "string" || !child.name.trim() || child.name.length > 256 || !Array.isArray(child.records) || !child.records.every(isPortalRecord) || child.sections !== void 0 && (!Array.isArray(child.sections) || !child.sections.every(isChildLessonSection) || new Set(child.sections).size !== child.sections.length) || childIds.has(child.id) || child.records.some((record) => !isRecord(record.context) || record.context.childId !== child.id)) {
      return { status: "invalid", kind: "lessons", reason: "invalid-json-records" };
    }
    const sections = child.sections;
    if (child.records.some(
      (record) => record.format === "html" && record.childSection !== void 0 && !(sections == null ? void 0 : sections.includes(record.childSection))
    )) {
      return { status: "invalid", kind: "lessons", reason: "invalid-json-records" };
    }
    childIds.add(child.id);
    children.push({
      id: child.id,
      name: child.name,
      records: child.records,
      ...sections !== void 0 ? { sections } : {}
    });
  }
  const records = children.flatMap((child) => child.records);
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    return { status: "invalid", kind: "lessons", reason: "invalid-json-records" };
  }
  return { status: "complete", kind: "lessons", records, groups: [], children };
}
function isChildLessonSection(value) {
  return value === "current" || value === "assignments" || value === "history" || value === "attendance" || value === "marks" || value === "exams" || value === "other";
}
function isChildLessonRecordSection(value) {
  return value === "current" || value === "assignments" || value === "attendance" || value === "other";
}
function isPortalRecord(value) {
  if (!isRecord(value) || typeof value.id !== "string" || !/^(?:source|hash):[a-f0-9]{64}$/u.test(value.id)) {
    return false;
  }
  if (value.context !== void 0) {
    if (!isRecord(value.context)) {
      return false;
    }
    if ("childId" in value.context && (typeof value.context.childId !== "string" || !/^[a-f0-9]{64}$/u.test(value.context.childId))) {
      return false;
    }
  }
  if (value.format === "json") {
    return isRecord(value.fields);
  }
  return value.format === "html" && typeof value.section === "string" && (value.childSection === void 0 || isChildLessonRecordSection(value.childSection)) && isRecord(value.attributes) && Array.isArray(value.fields);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hashAggregateId(namespace, sourceId) {
  return `source:${(0, import_node_crypto.createHash)("sha256").update(namespace).update("\0").update(sourceId).digest("hex")}`;
}
function fitsAggregationLimit(records) {
  const data = JSON.stringify(records);
  return typeof data === "string" && Buffer.byteLength(data) <= MAX_AGGREGATED_BYTES;
}
function fitsParentAggregationLimit(children) {
  const data = JSON.stringify({ children });
  return typeof data === "string" && Buffer.byteLength(data) <= MAX_AGGREGATED_BYTES;
}
function aggregatedResponse(records) {
  return {
    status: 200,
    classification: "success",
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(records), "utf8")
  };
}
function aggregatedLessonsResponse(children) {
  return {
    status: 200,
    classification: "success",
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ children }), "utf8")
  };
}
function fitsChildTimetableAggregationLimit(children) {
  const data = JSON.stringify({ childTimetables: children });
  return typeof data === "string" && Buffer.byteLength(data) <= MAX_AGGREGATED_BYTES;
}
function aggregatedChildTimetablesResponse(children) {
  return {
    status: 200,
    classification: "success",
    contentType: "application/json",
    body: Buffer.from(JSON.stringify({ childTimetables: children }), "utf8")
  };
}
async function readSchoolCalendar(reader, year) {
  var _a;
  const csvResponse = await reader.get(`/kalender.php?a=export&export=csv&year=${year}`);
  if (csvResponse.classification !== "success") {
    return csvResponse;
  }
  const csvResult = (0, import_portal_parser.parsePortalResource)(
    "school-calendar",
    Buffer.from(csvResponse.body).toString("utf8"),
    (_a = csvResponse.contentType) != null ? _a : void 0
  );
  if (csvResult.status === "complete" && csvResult.records.length > 0) {
    return csvResponse;
  }
  return reader.get(`/kalender.php?a=export&export=ical&year=${year}`);
}
async function readSubstitutions(reader) {
  var _a, _b, _c;
  const dateList = await reader.get("/vertretungsplan.php");
  if (dateList.classification !== "success") {
    return dateList;
  }
  const listingBody = Buffer.from(dateList.body).toString("utf8");
  const parsedListing = (0, import_portal_parser.parsePortalResource)("substitutions", listingBody, (_a = dateList.contentType) != null ? _a : void 0);
  if (parsedListing.status === "complete") {
    return dateList;
  }
  const parsedDates = (0, import_portal_parser.parsePortalResource)("substitution-dates", listingBody, (_b = dateList.contentType) != null ? _b : void 0);
  if (parsedDates.status !== "complete") {
    return dateList;
  }
  const dates = parsedDates.records.flatMap((record) => {
    if (record.format !== "json" || typeof record.fields.date !== "string" || typeof record.fields.portalTag !== "string") {
      return [];
    }
    return [{ date: record.fields.date, portalTag: record.fields.portalTag }];
  });
  if (dates.length !== parsedDates.records.length || dates.length > import_portal_parser.MAX_SUBSTITUTION_DATES) {
    return incompleteAggregation();
  }
  const substitutions = [];
  for (const { date, portalTag } of dates) {
    const response = await reader.postRead({ type: "substitution-day", date, portalTag });
    if (response.classification !== "success") {
      return response;
    }
    const parsedDay = (0, import_portal_parser.parsePortalResource)(
      "substitutions",
      Buffer.from(response.body).toString("utf8"),
      (_c = response.contentType) != null ? _c : void 0
    );
    if (parsedDay.status !== "complete") {
      return incompleteAggregation();
    }
    for (const record of parsedDay.records) {
      if (record.format !== "json") {
        return incompleteAggregation();
      }
      substitutions.push({ ...record.fields, portalDate: date });
    }
  }
  const body = Buffer.from(JSON.stringify(substitutions), "utf8");
  if (body.byteLength > 4 * 1024 * 1024) {
    return incompleteAggregation();
  }
  return { status: 200, classification: "success", contentType: "application/json", body };
}
function incompleteAggregation(diagnosticCode) {
  return {
    status: 200,
    classification: "unknown",
    contentType: "application/json",
    body: new Uint8Array(),
    ...diagnosticCode ? { diagnosticCode } : {}
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createPortalResourceRequests
});
//# sourceMappingURL=portal-data-requests.js.map
