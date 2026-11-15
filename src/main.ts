import type * as utils from '@iobroker/adapter-core';
import { SchulportalHessenAdapter } from './lib/adapter';

if (require.main !== module) {
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SchulportalHessenAdapter(options);
} else {
	(() => new SchulportalHessenAdapter())();
}
