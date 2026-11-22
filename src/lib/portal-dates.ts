/** Date strings used by the read-only portal endpoints, based on Europe/Berlin. */
export interface PortalDateWindow {
	/** Current Berlin-local date in YYYY-MM-DD form. */
	today: string;
	/** Next Berlin-local calendar date in YYYY-MM-DD form. */
	tomorrow: string;
	/** Current Berlin-local date in DD.MM.YYYY form. */
	substitutionDate: string;
	/** Inclusive calendar query start, 120 calendar days before today. */
	calendarStart: string;
	/** Inclusive calendar query end, 356 calendar days after today. */
	calendarEnd: string;
	/** School-year start derived from verified Hessian summer-holiday ends, with an August fallback beyond 2030. */
	schoolYearStart: number;
}

const HESSIAN_SUMMER_HOLIDAY_ENDS = [
	['2025-08-15', 2025],
	['2026-08-07', 2026],
	['2027-08-06', 2027],
	['2028-08-11', 2028],
	['2029-08-24', 2029],
	['2030-08-30', 2030],
] as const;

const BERLIN_DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/Berlin',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

function berlinDate(now: Date): Date {
	if (!Number.isFinite(now.getTime())) {
		throw new RangeError('Invalid reference date');
	}
	const parts = Object.fromEntries(BERLIN_DATE_FORMATTER.formatToParts(now).map(part => [part.type, part.value]));
	return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

function formatIsoDate(date: Date): string {
	return `${date.getUTCFullYear().toString().padStart(4, '0')}-${(date.getUTCMonth() + 1).toString().padStart(2, '0')}-${date
		.getUTCDate()
		.toString()
		.padStart(2, '0')}`;
}

function getSchoolYearStart(berlinDate: string): number {
	for (let index = 0; index < HESSIAN_SUMMER_HOLIDAY_ENDS.length - 1; index++) {
		const [summerEnd, schoolYear] = HESSIAN_SUMMER_HOLIDAY_ENDS[index];
		const nextSummerEnd = HESSIAN_SUMMER_HOLIDAY_ENDS[index + 1][0];
		if (berlinDate > summerEnd && berlinDate <= nextSummerEnd) {
			return schoolYear;
		}
	}

	const [year, month] = berlinDate.split('-').map(Number);
	return month >= 8 ? year : year - 1;
}

function addCalendarDays(date: Date, days: number): Date {
	const result = new Date(date.getTime());
	result.setUTCDate(result.getUTCDate() + days);
	return result;
}

/**
 * Build the confirmed API date formats without interpreting timestamps in the host timezone.
 *
 * @param now Reference instant used for the Berlin-local calendar date.
 */
export function getPortalDateWindow(now = new Date()): PortalDateWindow {
	const berlinToday = berlinDate(now);
	const year = berlinToday.getUTCFullYear().toString().padStart(4, '0');
	const month = (berlinToday.getUTCMonth() + 1).toString().padStart(2, '0');
	const day = berlinToday.getUTCDate().toString().padStart(2, '0');
	return {
		today: formatIsoDate(berlinToday),
		tomorrow: formatIsoDate(addCalendarDays(berlinToday, 1)),
		substitutionDate: `${day}.${month}.${year}`,
		calendarStart: formatIsoDate(addCalendarDays(berlinToday, -120)),
		calendarEnd: formatIsoDate(addCalendarDays(berlinToday, 356)),
		schoolYearStart: getSchoolYearStart(formatIsoDate(berlinToday)),
	};
}
