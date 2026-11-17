"use strict";
var import_adapter = require("./lib/adapter");
if (require.main !== module) {
  module.exports = (options) => new import_adapter.SchulportalHessenAdapter(options);
} else {
  (() => new import_adapter.SchulportalHessenAdapter())();
}
//# sourceMappingURL=main.js.map
