import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Admin school selection', () => {
	const config = JSON.parse(readFileSync(join(__dirname, '../../admin/jsonConfig.json'), 'utf8')) as {
		items: Record<string, Record<string, unknown>>;
	};

	it('keeps typed search text separate from the selected directory school ID', () => {
		expect(config.items.schoolSearch.type).to.equal('text');
		expect(config.items.schoolId.type).to.equal('selectSendTo');
		expect(config.items.schoolId.command).to.equal('searchSchools');
		expect(config.items.schoolId.manual).to.equal(false);
		expect(config.items.schoolId.jsonData).to.include('${data.schoolSearch}');
		expect(config.items.schoolId.alsoDependsOn).to.deep.equal(['schoolSearch']);
	});
});
