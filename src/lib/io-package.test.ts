import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ioPackage = JSON.parse(readFileSync(join(__dirname, '../../io-package.json'), 'utf8')) as {
	common: { messagebox?: boolean };
};

describe('Adapter message handling', () => {
	it('enables the messagebox for Admin school-search callbacks', () => {
		expect(ioPackage.common.messagebox).to.equal(true);
	});
});
