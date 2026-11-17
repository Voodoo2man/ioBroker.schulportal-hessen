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
var portal_diagnostics_exports = {};
__export(portal_diagnostics_exports, {
  formatInvalidTimetableDiagnostic: () => formatInvalidTimetableDiagnostic,
  formatOversizedResponseDiagnostic: () => formatOversizedResponseDiagnostic
});
module.exports = __toCommonJS(portal_diagnostics_exports);
function getSafeContentType(contentType) {
  const mediaType = contentType == null ? void 0 : contentType.split(";", 1)[0].trim().toLowerCase();
  if (!mediaType) {
    return "missing";
  }
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return "text/html";
  }
  if (mediaType === "application/json" || mediaType === "text/json" || mediaType.endsWith("+json")) {
    return "application/json";
  }
  if (mediaType === "text/csv" || mediaType === "application/csv") {
    return "text/csv";
  }
  if (mediaType === "text/calendar" || mediaType === "application/calendar" || mediaType === "text/icalendar" || mediaType === "text/x-vcalendar" || mediaType === "application/ics") {
    return "text/calendar";
  }
  if (mediaType === "text/plain") {
    return "text/plain";
  }
  return "other";
}
function formatOversizedResponseDiagnostic(response) {
  var _a, _b, _c;
  const size = response.responseSizeDiagnostic;
  return [
    `http=${response.status}`,
    `content-type=${getSafeContentType(response.contentType)}`,
    `limit-bytes=${(_a = size == null ? void 0 : size.limitBytes) != null ? _a : "unknown"}`,
    `declared-content-length=${(_b = size == null ? void 0 : size.declaredContentLength) != null ? _b : "unavailable"}`,
    `streaming-exceeded-limit=${(size == null ? void 0 : size.streamingExceededLimit) === true}`,
    `prefix-classification=${(_c = size == null ? void 0 : size.prefixClassification) != null ? _c : "not-inspected"}`
  ].join("; ");
}
function formatInvalidTimetableDiagnostic(response) {
  var _a;
  return [
    "reason=timetable-sections-missing-with-tables",
    `http=${response.status}`,
    `content-type=${getSafeContentType(response.contentType)}`,
    `body-bytes=${(_a = response.bodyByteLength) != null ? _a : response.body.byteLength}`
  ].join("; ");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  formatInvalidTimetableDiagnostic,
  formatOversizedResponseDiagnostic
});
//# sourceMappingURL=portal-diagnostics.js.map
