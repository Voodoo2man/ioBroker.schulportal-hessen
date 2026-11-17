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
var id_path_segments_exports = {};
__export(id_path_segments_exports, {
  allocateIdPathSegments: () => allocateIdPathSegments
});
module.exports = __toCommonJS(id_path_segments_exports);
const MAX_SEGMENT_LENGTH = 64;
const EMPTY_LABEL_FALLBACK = "unnamed";
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function toBaseSegment(displayName) {
  const segment = displayName.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase().replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SEGMENT_LENGTH).replace(/-+$/g, "");
  return segment || EMPTY_LABEL_FALLBACK;
}
function addNumericSuffix(baseSegment, suffix) {
  const suffixText = `-${suffix}`;
  const prefix = baseSegment.slice(0, MAX_SEGMENT_LENGTH - suffixText.length).replace(/-+$/g, "");
  return prefix ? `${prefix}${suffixText}` : String(suffix);
}
function allocateIdPathSegments(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError("entries must be an array");
  }
  const sourceIds = /* @__PURE__ */ new Set();
  const normalizedEntries = entries.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new TypeError("each entry must be an object");
    }
    if (typeof entry.sourceId !== "string" || entry.sourceId.trim().length === 0) {
      throw new TypeError("sourceId must be a non-empty string");
    }
    if (sourceIds.has(entry.sourceId)) {
      throw new Error("sourceId values must be unique");
    }
    if (typeof entry.displayName !== "string") {
      throw new TypeError("displayName must be a string");
    }
    sourceIds.add(entry.sourceId);
    return { sourceId: entry.sourceId, baseSegment: toBaseSegment(entry.displayName) };
  });
  normalizedEntries.sort((left, right) => compareStrings(left.sourceId, right.sourceId));
  const groups = /* @__PURE__ */ new Map();
  for (const entry of normalizedEntries) {
    const group = groups.get(entry.baseSegment);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.baseSegment, [entry]);
    }
  }
  const usedSegments = new Set(groups.keys());
  const allocatedEntries = [];
  for (const baseSegment of [...groups.keys()].sort(compareStrings)) {
    const group = groups.get(baseSegment);
    allocatedEntries.push({ sourceId: group[0].sourceId, segment: baseSegment });
    let suffix = 2;
    for (let index = 1; index < group.length; index++) {
      let segment = addNumericSuffix(baseSegment, suffix);
      while (usedSegments.has(segment)) {
        segment = addNumericSuffix(baseSegment, ++suffix);
      }
      usedSegments.add(segment);
      allocatedEntries.push({ sourceId: group[index].sourceId, segment });
      suffix++;
    }
  }
  allocatedEntries.sort((left, right) => compareStrings(left.sourceId, right.sourceId));
  return new Map(allocatedEntries.map(({ sourceId, segment }) => [sourceId, segment]));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  allocateIdPathSegments
});
//# sourceMappingURL=id-path-segments.js.map
