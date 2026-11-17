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
  RECOVERABLE_SCHOOL_ID_ERROR: () => RECOVERABLE_SCHOOL_ID_ERROR,
  hasOnlyRecoverableSchoolSearchErrors: () => hasOnlyRecoverableSchoolSearchErrors,
  validateAdapterConfig: () => validateAdapterConfig
});
module.exports = __toCommonJS(config_validation_exports);
const CENTRAL_CREDENTIAL_ID_PATTERN = /^system\.credentials\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SCHOOL_ID_PATTERN = /^\d{1,20}$/;
const RECOVERABLE_SCHOOL_ID_ERROR = "schoolId must be a numeric Schulportal school ID of 1 to 20 digits";
const SCHOOL_CREDENTIAL_PAIR_ERROR = "schoolId and credentialId must both be configured for an account";
const ACCOUNT_NAME_REQUIREMENT_ERROR = "accountName may only be set when both schoolId and credentialId are configured";
const RECOVERABLE_SCHOOL_SEARCH_ERRORS = /* @__PURE__ */ new Set([
  RECOVERABLE_SCHOOL_ID_ERROR,
  SCHOOL_CREDENTIAL_PAIR_ERROR,
  ACCOUNT_NAME_REQUIREMENT_ERROR
]);
function hasOnlyRecoverableSchoolSearchErrors(errors) {
  return errors.length > 0 && errors.every((error) => RECOVERABLE_SCHOOL_SEARCH_ERRORS.has(error));
}
const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;
const MIN_REFRESH_INTERVAL_MINUTES = 5;
const MAX_REFRESH_INTERVAL_MINUTES = 1440;
const ALLOWED_CONFIG_FIELDS = /* @__PURE__ */ new Set([
  "accountName",
  "schoolSearch",
  "schoolId",
  "credentialId",
  "refreshIntervalMinutes",
  "accounts"
]);
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
function validateAdapterConfig(config) {
  const errors = [];
  const refreshInterval = config.refreshIntervalMinutes === void 0 ? DEFAULT_REFRESH_INTERVAL_MINUTES : config.refreshIntervalMinutes;
  if (typeof refreshInterval !== "number" || !Number.isInteger(refreshInterval) || refreshInterval < MIN_REFRESH_INTERVAL_MINUTES || refreshInterval > MAX_REFRESH_INTERVAL_MINUTES) {
    errors.push(
      `refreshIntervalMinutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}`
    );
  }
  if (Object.prototype.hasOwnProperty.call(config, "accounts") && (!Array.isArray(config.accounts) || config.accounts.length > 0)) {
    errors.push(
      "non-empty accounts is no longer supported; configure exactly one Schulportal Hessen account per adapter instance and add another adapter instance for each additional account"
    );
    return errors;
  }
  for (const field of Object.keys(config)) {
    if (PLAINTEXT_CREDENTIAL_FIELDS.has(field.toLowerCase())) {
      errors.push(`${field} must not be stored in adapter configuration; use a central credential reference`);
    } else if (!ALLOWED_CONFIG_FIELDS.has(field)) {
      errors.push(`${field} is not a supported adapter setting`);
    }
  }
  if (config.accountName !== void 0 && typeof config.accountName !== "string") {
    errors.push("accountName must be a string");
  }
  if (config.schoolSearch !== void 0 && (typeof config.schoolSearch !== "string" || config.schoolSearch.length > 100)) {
    errors.push("schoolSearch must be a string of at most 100 characters");
  }
  if (config.schoolId !== void 0 && typeof config.schoolId !== "string") {
    errors.push("schoolId must be a string");
  }
  if (config.credentialId !== void 0 && typeof config.credentialId !== "string") {
    errors.push("credentialId must be a string");
  }
  const accountName = typeof config.accountName === "string" ? config.accountName.trim() : "";
  const schoolId = typeof config.schoolId === "string" ? config.schoolId : "";
  const credentialId = typeof config.credentialId === "string" ? config.credentialId : "";
  const hasSchoolId = schoolId.length > 0;
  const hasCredentialId = credentialId.length > 0;
  if (hasSchoolId !== hasCredentialId) {
    errors.push(SCHOOL_CREDENTIAL_PAIR_ERROR);
  }
  if (accountName && (!hasSchoolId || !hasCredentialId)) {
    errors.push(ACCOUNT_NAME_REQUIREMENT_ERROR);
  }
  if (hasSchoolId && !SCHOOL_ID_PATTERN.test(schoolId)) {
    errors.push(RECOVERABLE_SCHOOL_ID_ERROR);
  }
  if (hasCredentialId && !CENTRAL_CREDENTIAL_ID_PATTERN.test(credentialId)) {
    errors.push("credentialId must reference a valid central ioBroker credential");
  }
  return errors;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_REFRESH_INTERVAL_MINUTES,
  MAX_REFRESH_INTERVAL_MINUTES,
  MIN_REFRESH_INTERVAL_MINUTES,
  RECOVERABLE_SCHOOL_ID_ERROR,
  hasOnlyRecoverableSchoolSearchErrors,
  validateAdapterConfig
});
//# sourceMappingURL=config-validation.js.map
