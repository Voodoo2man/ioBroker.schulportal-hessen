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
var dynamic_record_sync_exports = {};
__export(dynamic_record_sync_exports, {
  getGeneratedObjectNameUpdate: () => getGeneratedObjectNameUpdate,
  planDynamicRecordSync: () => planDynamicRecordSync,
  toSafeDynamicRecordId: () => toSafeDynamicRecordId
});
module.exports = __toCommonJS(dynamic_record_sync_exports);
var import_node_crypto = require("node:crypto");
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
function getGeneratedObjectNameUpdate(currentName, previousGeneratedName, nextGeneratedName) {
  if (typeof currentName !== "string" || typeof previousGeneratedName !== "string" || currentName !== previousGeneratedName || previousGeneratedName === nextGeneratedName) {
    return null;
  }
  return nextGeneratedName;
}
function toSafeDynamicRecordId(sourceId) {
  if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > 4096) {
    throw new RangeError("Invalid dynamic record source ID");
  }
  return (0, import_node_crypto.createHash)("sha256").update(sourceId).digest("hex");
}
function planDynamicRecordSync(previousIds, currentIds, complete) {
  if (!complete) {
    return null;
  }
  const uniqueCurrentIds = /* @__PURE__ */ new Set();
  for (const id of currentIds) {
    if (!RECORD_ID_PATTERN.test(id) || uniqueCurrentIds.has(id)) {
      throw new RangeError("Invalid or duplicate dynamic record ID");
    }
    uniqueCurrentIds.add(id);
  }
  return {
    currentIds: [...uniqueCurrentIds].sort(),
    staleIds: [...new Set(previousIds)].filter((id) => RECORD_ID_PATTERN.test(id) && !uniqueCurrentIds.has(id))
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getGeneratedObjectNameUpdate,
  planDynamicRecordSync,
  toSafeDynamicRecordId
});
//# sourceMappingURL=dynamic-record-sync.js.map
