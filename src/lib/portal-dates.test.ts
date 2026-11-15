import { expect } from 'chai';
import { getPortalDateWindow } from './portal-dates';

describe('getPortalDateWindow', () => {
	it('uses the Europe/Berlin calendar date and applies the verified event range', () => {
		const result = getPortalDateWindow(new Date('2026-03-29T23:30:00.000Z'));

		expect(result).to.deep.equal({
			today: '2026-03-30',
			substitutionDate: '30.03.2026',
			calendarStart: '2025-11-30',
			calendarEnd: '2027-03-21',
			schoolYearStart: 2025,
		});
	});

	it('selects the school year from verified Berlin-local summer-holiday boundaries', () => {
		expect(getPortalDateWindow(new Date('2026-08-07T10:00:00.000Z')).schoolYearStart).to.equal(2025);
		expect(getPortalDateWindow(new Date('2026-08-07T22:00:00.000Z')).schoolYearStart).to.equal(2026);
		expect(getPortalDateWindow(new Date('2032-01-10T12:00:00.000Z')).schoolYearStart).to.equal(2031);
	});

	it('rejects an invalid reference date', () => {
		expect(() => getPortalDateWindow(new Date(Number.NaN))).to.throw(RangeError);
	});
});
