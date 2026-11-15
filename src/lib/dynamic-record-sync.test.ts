import { expect } from 'chai';
import { getGeneratedObjectNameUpdate, planDynamicRecordSync, toSafeDynamicRecordId } from './dynamic-record-sync';

describe('getGeneratedObjectNameUpdate', () => {
	it('updates an unchanged generated name while preserving a user-customized name', () => {
		expect(getGeneratedObjectNameUpdate('Old label', 'Old label', 'Current label')).to.equal('Current label');
		expect(getGeneratedObjectNameUpdate('Custom label', 'Old label', 'Current label')).to.equal(null);
		expect(getGeneratedObjectNameUpdate('Old label', undefined, 'Current label')).to.equal(null);
	});
});

describe('planDynamicRecordSync', () => {
	it('maps parser IDs to stable opaque ioBroker-safe IDs', () => {
		const id = toSafeDynamicRecordId('source:school/student 42');
		expect(id).to.match(/^[a-f0-9]{64}$/u);
		expect(toSafeDynamicRecordId('source:school/student 42')).to.equal(id);
		expect(id).not.to.include('student');
		expect(() => toSafeDynamicRecordId('')).to.throw(RangeError);
	});

	it('does not schedule deletion for an incomplete response', () => {
		expect(planDynamicRecordSync(['old-record'], ['new-record'], false)).to.equal(null);
	});

	it('removes stale records only after a complete result, including confirmed empty results', () => {
		expect(planDynamicRecordSync(['stale', 'keep'], ['keep', 'new'], true)).to.deep.equal({
			currentIds: ['keep', 'new'],
			staleIds: ['stale'],
		});
		expect(planDynamicRecordSync(['old'], [], true)).to.deep.equal({ currentIds: [], staleIds: ['old'] });
	});

	it('rejects duplicate or unsafe incoming IDs and ignores unsafe saved IDs', () => {
		expect(() => planDynamicRecordSync(['../unsafe', 'stale'], ['safe', 'safe'], true)).to.throw(RangeError);
		expect(planDynamicRecordSync(['../unsafe', 'stale'], ['safe'], true)).to.deep.equal({
			currentIds: ['safe'],
			staleIds: ['stale'],
		});
	});
});
