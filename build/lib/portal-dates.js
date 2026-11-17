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
var portal_dates_exports = {};
__export(portal_dates_exports, {
  getPortalDateWindow: () => getPortalDateWindow
});
module.exports = __toCommonJS(portal_dates_exports);
const HESSIAN_SUMMER_HOLIDAY_ENDS = [
  ["2025-08-15", 2025],
  ["2026-08-07", 2026],
  ["2027-08-06", 2027],
  ["2028-08-11", 2028],
  ["2029-08-24", 2029],
  ["2030-08-30", 2030]
];
const BERLIN_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
function berlinDate(now) {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("Invalid reference date");
  }
  const parts = Object.fromEntries(BERLIN_DATE_FORMATTER.formatToParts(now).map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}
function formatIsoDate(date) {
  return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}
function getSchoolYearStart(berlinDate2) {
  for (let index = 0; index < HESSIAN_SUMMER_HOLIDAY_ENDS.length - 1; index++) {
    const [summerEnd, schoolYear] = HESSIAN_SUMMER_HOLIDAY_ENDS[index];
    const nextSummerEnd = HESSIAN_SUMMER_HOLIDAY_ENDS[index + 1][0];
    if (berlinDate2 > summerEnd && berlinDate2 <= nextSummerEnd) {
      return schoolYear;
    }
  }
  const [year, month] = berlinDate2.split("-").map(Number);
  return month >= 8 ? year : year - 1;
}
function addCalendarDays(date, days) {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}
function getPortalDateWindow(now = /* @__PURE__ */ new Date()) {
  const berlinToday = berlinDate(now);
  const year = berlinToday.getUTCFullYear().toString().padStart(4, "0");
  const month = (berlinToday.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = berlinToday.getUTCDate().toString().padStart(2, "0");
  return {
    today: formatIsoDate(berlinToday),
    substitutionDate: `${day}.${month}.${year}`,
    calendarStart: formatIsoDate(addCalendarDays(berlinToday, -120)),
    calendarEnd: formatIsoDate(addCalendarDays(berlinToday, 356)),
    schoolYearStart: getSchoolYearStart(formatIsoDate(berlinToday))
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getPortalDateWindow
});
//# sourceMappingURL=portal-dates.js.map
