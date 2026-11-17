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
var refresh_coordinator_exports = {};
__export(refresh_coordinator_exports, {
  RefreshCoordinator: () => RefreshCoordinator
});
module.exports = __toCommonJS(refresh_coordinator_exports);
class RefreshCoordinator {
  active = null;
  /**
   * Run the operation once and share its promise with concurrent callers.
   *
   * @param operation Work to run after the current operation settles.
   */
  run(operation) {
    if (this.active) {
      return this.active;
    }
    const running = Promise.resolve().then(operation);
    this.active = running;
    void running.finally(() => {
      if (this.active === running) {
        this.active = null;
      }
    }).catch(() => void 0);
    return running;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  RefreshCoordinator
});
//# sourceMappingURL=refresh-coordinator.js.map
