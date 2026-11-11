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
var config_validation_exports = {};
__export(config_validation_exports, {
  DEFAULT_REFRESH_INTERVAL_MINUTES: () => DEFAULT_REFRESH_INTERVAL_MINUTES,
  MAX_REFRESH_INTERVAL_MINUTES: () => MAX_REFRESH_INTERVAL_MINUTES,
  MIN_REFRESH_INTERVAL_MINUTES: () => MIN_REFRESH_INTERVAL_MINUTES,
  validateAdapterConfig: () => validateAdapterConfig
});
module.exports = __toCommonJS(config_validation_exports);
const CREDENTIALS_PREFIX = "system.credentials.";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;
const MIN_REFRESH_INTERVAL_MINUTES = 5;
const MAX_REFRESH_INTERVAL_MINUTES = 1440;
const PLAINTEXT_CREDENTIAL_FIELDS = /* @__PURE__ */ new Set([
  "login",
  "password",
  "pass",
  "username",
  "user",
  "user2",
  "cookie",
  "sid",
  "token",
  "secret"
]);
const ALLOWED_ACCOUNT_FIELDS = /* @__PURE__ */ new Set(["id", "displayName", "schoolId", "enabled", "credentialId"]);
function validateAdapterConfig(config) {
  const errors = [];
  const refreshInterval = config.refreshIntervalMinutes === void 0 ? DEFAULT_REFRESH_INTERVAL_MINUTES : config.refreshIntervalMinutes;
  if (typeof refreshInterval !== "number" || !Number.isInteger(refreshInterval) || refreshInterval < MIN_REFRESH_INTERVAL_MINUTES || refreshInterval > MAX_REFRESH_INTERVAL_MINUTES) {
    errors.push(
      `refreshIntervalMinutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}`
    );
  }
  const accounts = config.accounts === void 0 ? [] : config.accounts;
  if (!Array.isArray(accounts)) {
    return [...errors, "accounts must be an array"];
  }
  const accountIds = /* @__PURE__ */ new Set();
  for (const [index, account] of accounts.entries()) {
    const prefix = `accounts[${index}]`;
    if (typeof account !== "object" || account === null || Array.isArray(account)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of Object.keys(account)) {
      if (!ALLOWED_ACCOUNT_FIELDS.has(field)) {
        errors.push(`${prefix}.${field} is not a supported account setting`);
        if (PLAINTEXT_CREDENTIAL_FIELDS.has(field.toLowerCase())) {
          errors.push(`${prefix} must reference central credentials instead of storing login or password fields`);
        }
      }
    }
    if (typeof account.id !== "string" || !ACCOUNT_ID_PATTERN.test(account.id)) {
      errors.push(`${prefix}.id must be an opaque UUID`);
    } else if (accountIds.has(account.id.toLowerCase())) {
      errors.push(`${prefix}.id must be unique`);
    } else {
      accountIds.add(account.id.toLowerCase());
    }
    if (typeof account.enabled !== "boolean") {
      errors.push(`${prefix}.enabled must be a boolean`);
    }
    if (account.enabled !== true) {
      continue;
    }
    if (typeof account.displayName !== "string" || account.displayName.trim().length === 0) {
      errors.push(`${prefix}.displayName is required for enabled accounts`);
    }
    if (typeof account.schoolId !== "string" || account.schoolId.trim().length === 0) {
      errors.push(`${prefix}.schoolId is required for enabled accounts`);
    }
    if (typeof account.credentialId !== "string" || !account.credentialId.startsWith(CREDENTIALS_PREFIX)) {
      errors.push(`${prefix}.credentialId must reference a central ioBroker credential`);
    }
  }
  return errors;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  MAX_REFRESH_INTERVAL_MINUTES,
  MIN_REFRESH_INTERVAL_MINUTES,
  validateAdapterConfig
});
//# sourceMappingURL=config-validation.js.map
