import * as utils from '@iobroker/adapter-core';
import {
	validateAdapterConfig,
	DEFAULT_REFRESH_INTERVAL_MINUTES,
	hasOnlyRecoverableSchoolSearchErrors,
	RECOVERABLE_SCHOOL_ID_ERROR,
} from './config-validation';
import { getGeneratedObjectNameUpdate, planDynamicRecordSync, toSafeDynamicRecordId } from './dynamic-record-sync';
import { allocateIdPathSegments } from './id-path-segments';
import { getPortalDateWindow } from './portal-dates';
import type { PortalResourceKind, PortalResourceRequest } from './portal-data-requests';
import { createPortalResourceRequests } from './portal-data-requests';
import { formatInvalidTimetableDiagnostic, formatOversizedResponseDiagnostic } from './portal-diagnostics';
import { PortalSession, PortalSessionError } from './portal-session';
import { fetchSchoolOptions, searchSchoolOptions, type SchoolOption } from './portal-school-directory';
import { RefreshCoordinator } from './refresh-coordinator';
import {
	parsePortalResource,
	type ChildLessonSection,
	type PortalChildLessons,
	type PortalChildTimetable,
	type PortalRecord,
} from './portal-parser';

const STUDENTS_BASE = 'students';
const INBOX_BASE = 'inbox';
const INBOX_CATEGORIES = ['read', 'unread'] as const;
const SUBSTITUTION_COLUMN_ALIASES = {
	stunde: 'period',
	klasse: 'class',
	vertretung: 'substitution',
	lehrkraft: 'teacher',
	fach: 'subject',
	raum: 'room',
	hinweis: 'note',
} as const;
type DailySubstitutionField = (typeof SUBSTITUTION_COLUMN_ALIASES)[keyof typeof SUBSTITUTION_COLUMN_ALIASES];
type DailySubstitutionRow = Record<DailySubstitutionField, string>;
const ACCOUNT_NAME_STATE = 'info.accountName';
const ACCOUNT_TYPE_STATE = 'info.accountType';
const ROOT_LAST_ERROR_STATE = 'info.lastError';
const RESOURCE_BASES: Record<PortalResourceKind, string> = {
	account: 'profile',
	timetable: `${STUDENTS_BASE}.timetable`,
	substitutions: 'substitutions',
	calendar: 'calendar.portal',
	'school-calendar': 'calendar.school',
	lessons: `${STUDENTS_BASE}.lessons`,
	'learning-groups': 'learningGroups',
	messages: INBOX_BASE,
	'file-metadata': 'files',
};

function getResourceBase(resource: PortalResourceKind): string {
	return RESOURCE_BASES[resource];
}

function getSubstitutionIsoDate(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value);
	if (!match) {
		return null;
	}
	const day = Number(match[1]);
	const month = Number(match[2]);
	const year = Number(match[3]);
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return null;
	}
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isIsoCalendarDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (!match) {
		return false;
	}
	return getSubstitutionIsoDate(`${match[3]}.${match[2]}.${match[1]}`) === value;
}

function getSubstitutionRecordDate(record: PortalRecord): string | null {
	return record.format === 'json' ? getSubstitutionIsoDate(record.fields.portalDate) : null;
}

function groupDailySubstitutionRows(records: readonly PortalRecord[]): Map<string, DailySubstitutionRow[]> {
	const groups = new Map<string, DailySubstitutionRow[]>();
	for (const record of records) {
		const date = getSubstitutionRecordDate(record);
		if (!date) {
			continue;
		}
		const dateRows = groups.get(date) ?? [];
		groups.set(date, dateRows);
		const columns = record.format === 'json' ? record.fields.columns : undefined;
		if (!Array.isArray(columns)) {
			continue;
		}
		const row: DailySubstitutionRow = {
			period: '',
			class: '',
			substitution: '',
			teacher: '',
			subject: '',
			room: '',
			note: '',
		};
		for (const column of columns) {
			if (typeof column !== 'object' || column === null || Array.isArray(column)) {
				continue;
			}
			const pair = column as Record<string, unknown>;
			if (typeof pair.header !== 'string' || typeof pair.value !== 'string') {
				continue;
			}
			const header = pair.header.trim().toLowerCase() as keyof typeof SUBSTITUTION_COLUMN_ALIASES;
			if (Object.hasOwn(SUBSTITUTION_COLUMN_ALIASES, header)) {
				row[SUBSTITUTION_COLUMN_ALIASES[header]] = pair.value;
			}
		}
		dateRows.push(row);
	}
	return groups;
}

const SCHOOL_OPTIONS_CACHE_MS = 6 * 60 * 60_000;
const REFRESH_STATE = 'info.refresh';
const ROOT_CONNECTION_STATE = 'info.connection';
const ROOT_STATUS_STATE = 'info.status';
const ROOT_LAST_UPDATE_STATE = 'info.lastUpdate';
const RESOURCE_NAMES: Record<PortalResourceKind, string> = {
	account: 'Profile',
	timetable: 'Timetable',
	substitutions: 'Substitutions',
	calendar: 'Portal calendar',
	'school-calendar': 'School calendar',
	lessons: 'Lessons and assignments',
	'learning-groups': 'Learning groups and assessments',
	messages: 'Inbox',
	'file-metadata': 'Files',
};
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type ChildLessonSectionId = ChildLessonSection;

const CHILD_LESSON_SECTION_NAMES: Record<ChildLessonSectionId, string> = {
	current: 'Current lessons',
	assignments: 'Assignments',
	history: 'History',
	attendance: 'Attendance',
	marks: 'Marks',
	exams: 'Exams',
	other: 'Other student data',
};

function getFixedResourceChildPaths(resource: PortalResourceKind, base: string): string[] {
	const paths = new Set(['status', 'count', 'lastUpdate', 'json', 'recordIds', 'recordPaths', 'records']);
	if (resource === 'messages') {
		paths.add('unreadCount');
	}
	if (resource === 'substitutions' && base === getResourceBase(resource)) {
		paths.add('dailyJsonDates');
	}
	if (resource === 'lessons' && base.endsWith('.lessons')) {
		paths.add('sectionIds');
		for (const section of Object.keys(CHILD_LESSON_SECTION_NAMES)) {
			paths.add(section);
		}
	}
	if (resource === 'timetable' && base.endsWith('.timetable')) {
		for (const path of ['today', 'tomorrow', 'week']) {
			paths.add(path);
		}
	}
	return [...paths];
}

type ParsedRecord = PortalRecord;

function getChildLessonSection(record: PortalRecord): ChildLessonSectionId {
	if (record.format !== 'html') {
		return 'other';
	}
	if (record.childSection) {
		return record.childSection;
	}
	switch (record.section) {
		case 'mappen':
			return 'assignments';
		case 'history':
			return 'history';
		case 'attendanceTable':
		case 'anwesend':
			return 'attendance';
		case 'marks':
			return 'marks';
		case 'klausuren':
			return 'exams';
		case 'current':
		case 'aktuell':
			return 'current';
		default:
			return 'other';
	}
}

function isProfileRecord(record: PortalRecord): record is Extract<PortalRecord, { format: 'json' }> {
	return record.format === 'json' && record.fields.recordType === 'profile';
}

function getProfileFieldValue(records: readonly PortalRecord[], aliases: readonly string[]): string {
	const normalizedAliases = new Set(aliases);
	const values = records.flatMap(record =>
		isProfileRecord(record) &&
		typeof record.fields.label === 'string' &&
		typeof record.fields.value === 'string' &&
		normalizedAliases.has(normalizeCalendarFieldName(record.fields.label))
			? [record.fields.value]
			: [],
	);
	return values.length === 1 ? values[0] : '';
}

function getAccountType(records: readonly PortalRecord[]): string {
	for (const record of records) {
		if (
			record.format === 'json' &&
			record.fields.recordType === 'account-type' &&
			(record.fields.type === 'parent' || record.fields.type === 'student' || record.fields.type === 'teacher')
		) {
			return record.fields.type;
		}
	}
	return '';
}

const PORTAL_SECTION_NAMES = new Map([
	['LGs', 'Learning groups'],
	['klausuren', 'Exams'],
	['mappen', 'Lesson folders'],
	['attendanceTable', 'Attendance'],
]);

function getReadableRecordName(record: PortalRecord, forDisplay = false): string {
	const sectionName =
		record.format === 'html'
			? record.childSection
				? CHILD_LESSON_SECTION_NAMES[record.childSection]
				: record.section === 'own'
					? 'Personal timetable'
					: record.section === 'all'
						? 'Class timetable'
						: ((forDisplay ? PORTAL_SECTION_NAMES.get(record.section) : undefined) ?? record.section)
			: typeof record.fields.name === 'string'
				? record.fields.name
				: typeof record.fields.title === 'string'
					? record.fields.title
					: typeof record.fields.subject === 'string'
						? record.fields.subject
						: typeof record.fields.summary === 'string'
							? record.fields.summary
							: typeof record.fields.label === 'string'
								? record.fields.label
								: 'Portal record';
	const values = record.format === 'html' ? record.fields.map(field => field.text) : [];
	const readableValues = values
		.map(value => value.replace(/\s+/gu, ' ').trim())
		.filter(value => value.length > 0 && !/^[a-f0-9]{24,}$/iu.test(value))
		.slice(0, 2);
	return [sectionName, ...readableValues].join(' — ').slice(0, 160);
}

const CALENDAR_START_FIELDS = new Set(['start', 'startsat', 'anfang']);
const CALENDAR_END_FIELDS = new Set(['end', 'endsat', 'ende']);
const BERLIN_CALENDAR_FORMATTER = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/Berlin',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

interface CalendarEventDates {
	start: string;
	end: string | null;
	endIsExclusive: boolean;
}

function normalizeCalendarFieldName(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/ß/gu, 'ss')
		.toLowerCase()
		.replace(/[^a-z0-9]/gu, '');
}

function getCalendarEventDates(record: PortalRecord): CalendarEventDates | null {
	if (record.format !== 'json' || typeof record.fields !== 'object' || record.fields === null) {
		return null;
	}
	const fields = record.fields;
	const start = getCalendarDateField(fields, CALENDAR_START_FIELDS, 'start_type', 'start_tzid');
	if (!start) {
		return null;
	}
	const hasEnd = Object.entries(fields).some(
		([name, value]) =>
			CALENDAR_END_FIELDS.has(normalizeCalendarFieldName(name)) &&
			value !== null &&
			value !== undefined &&
			!(typeof value === 'string' && !value.trim()),
	);
	const end = getCalendarDateField(fields, CALENDAR_END_FIELDS, 'end_type', 'end_tzid');
	if (hasEnd && !end) {
		return null;
	}
	return { start, end, endIsExclusive: fields.end_type === 'DATE' };
}

function getCalendarDateField(
	fields: Readonly<Record<string, unknown>>,
	aliases: ReadonlySet<string>,
	typeField: string,
	timeZoneField: string,
): string | null {
	const values = Object.entries(fields)
		.filter(([name]) => aliases.has(normalizeCalendarFieldName(name)))
		.map(([, value]) => value)
		.filter(value => !(typeof value === 'string' && !value.trim()));
	if (values.length === 0 || !values.every((value): value is string => typeof value === 'string')) {
		return null;
	}
	const dates = values.map(value => parseCalendarDate(value, fields[typeField], fields[timeZoneField]));
	if (dates.some(date => date === null) || new Set(dates).size !== 1) {
		return null;
	}
	return dates[0] ?? null;
}

function parseCalendarDate(value: string, dateType: unknown, timeZone: unknown): string | null {
	const trimmed = value.trim();
	const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
	const compactDate = /^(\d{4})(\d{2})(\d{2})$/u.exec(trimmed);
	if (isoDate || compactDate) {
		if (dateType === 'DATE-TIME') {
			return null;
		}
		const [, year, month, day] = (isoDate ?? compactDate)!;
		return isValidCalendarDate(Number(year), Number(month), Number(day)) ? `${year}-${month}-${day}` : null;
	}

	const isoDateTime =
		/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/iu.exec(trimmed);
	const compactDateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/iu.exec(trimmed);
	const dateTime = isoDateTime ?? compactDateTime;
	if (!dateTime || dateType === 'DATE') {
		return null;
	}
	const [, year, month, day, hour, minute, second = '0', zone = ''] = dateTime;
	if (
		!isValidCalendarDate(Number(year), Number(month), Number(day)) ||
		Number(hour) > 23 ||
		Number(minute) > 59 ||
		Number(second) > 59
	) {
		return null;
	}

	if (timeZone !== undefined && timeZone !== null && typeof timeZone !== 'string') {
		return null;
	}
	const timeZoneName = typeof timeZone === 'string' ? timeZone : '';
	const isUtc = /^(?:UTC|ETC\/UTC|GMT)$/iu.test(timeZoneName);
	const berlinLocal = !timeZoneName || timeZoneName === 'Europe/Berlin';
	if (!zone && berlinLocal) {
		return `${year}-${month}-${day}`;
	}
	if (!zone && !isUtc) {
		return null;
	}
	const normalizedValue = isoDateTime
		? `${trimmed.replace(/([+-]\d{2})(\d{2})$/u, '$1:$2')}${!zone && isUtc ? 'Z' : ''}`
		: `${year}-${month}-${day}T${hour}:${minute}:${second}${zone || 'Z'}`;
	const instant = Date.parse(normalizedValue);
	if (!Number.isFinite(instant)) {
		return null;
	}
	const parts = Object.fromEntries(
		BERLIN_CALENDAR_FORMATTER.formatToParts(instant).map(part => [part.type, part.value]),
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) {
		return false;
	}
	const days = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return day <= (days[month - 1] ?? 0);
}

function isCurrentCalendarEvent(record: PortalRecord, today: string): boolean {
	const dates = getCalendarEventDates(record);
	if (!dates || (dates.end !== null && dates.end < dates.start)) {
		return false;
	}
	if (!dates.end) {
		return dates.start >= today;
	}
	return dates.endIsExclusive ? dates.end > today : dates.end >= today;
}

function isCompactRecordResource(resource: PortalResourceKind): boolean {
	return resource === 'calendar' || resource === 'school-calendar' || resource === 'file-metadata';
}

function getReadableRecordPathName(resource: PortalResourceKind, record: PortalRecord): string {
	if (resource === 'calendar' || resource === 'school-calendar') {
		const dates = getCalendarEventDates(record);
		if (!dates) {
			throw new Error('Calendar record is missing a readable start date');
		}
		return `${dates.start}-${getReadableRecordName(record)}`;
	}
	if (resource === 'account') {
		return `field-${getReadableRecordName(record)}`;
	}
	return getReadableRecordName(record);
}

type TimetableWeekdayId = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

const TIMETABLE_WEEKDAYS: readonly { id: TimetableWeekdayId; names: readonly string[] }[] = [
	{ id: 'monday', names: ['monday', 'mon', 'montag', 'mo'] },
	{ id: 'tuesday', names: ['tuesday', 'tue', 'tues', 'dienstag', 'di'] },
	{ id: 'wednesday', names: ['wednesday', 'wed', 'mittwoch', 'mi'] },
	{ id: 'thursday', names: ['thursday', 'thu', 'thur', 'thurs', 'donnerstag', 'do'] },
	{ id: 'friday', names: ['friday', 'fri', 'freitag', 'fr'] },
	{ id: 'saturday', names: ['saturday', 'sat', 'samstag', 'sa'] },
	{ id: 'sunday', names: ['sunday', 'sun', 'sonntag', 'so'] },
];

interface TimetableBuckets {
	today: PortalRecord[];
	tomorrow: PortalRecord[];
	week: Record<TimetableWeekdayId, PortalRecord[]>;
}

interface ChildTimetableAssignment {
	child: PortalChildTimetable;
	childPath: string;
	buckets: TimetableBuckets;
}

interface PathReservation {
	ownerId: string;
	path: string;
	fixed?: boolean;
}

interface RecordFieldDescriptor {
	id: string;
	previousId?: string;
	name: string;
	value: string | number | boolean;
	type: ioBroker.CommonType;
	role: string;
}

const SAFE_READABLE_PATH_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_READABLE_RECORD_PATH_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

function getSubstitutionRecordPaths(records: readonly PortalRecord[]): Map<string, string> {
	const entriesByChannel = new Map<string, { sourceId: string; displayName: string }[]>();
	for (const record of records) {
		const sourceId = toSafeDynamicRecordId(record.id);
		const parentChannel = getSubstitutionRecordDate(record) ?? 'undated';
		const entries = entriesByChannel.get(parentChannel) ?? [];
		entries.push({ sourceId, displayName: 'portal-record' });
		entriesByChannel.set(parentChannel, entries);
	}

	const paths = new Map<string, string>();
	for (const [parentChannel, entries] of entriesByChannel) {
		for (const [sourceId, segment] of allocateIdPathSegments(entries)) {
			paths.set(sourceId, `${parentChannel}.${segment}`);
		}
	}
	return paths;
}

function allocateSegmentsWithReservations(
	entries: readonly { sourceId: string; displayName: string }[],
	reservations: readonly PathReservation[],
): Map<string, string> {
	const fixedReservations = reservations.filter(({ fixed }) => fixed);
	const fixedEntries = fixedReservations.map(({ path }, index) => ({
		sourceId: `!fixed-${index}-${path.toLowerCase()}`,
		displayName: path.toLowerCase(),
	}));
	const baseline = allocateIdPathSegments([...entries, ...fixedEntries]);
	const reservedPaths = [
		...new Set(
			reservations
				.map(({ ownerId, path, fixed }) => ({ ownerId, path: path.toLowerCase(), fixed }))
				.filter(
					({ ownerId, path, fixed }) =>
						SAFE_READABLE_PATH_PATTERN.test(path) &&
						(fixed || baseline.get(ownerId)?.toLowerCase() !== path),
				)
				.map(({ path }) => path),
		),
	].sort();
	if (reservedPaths.length === 0) {
		return new Map(entries.map(({ sourceId }) => [sourceId, baseline.get(sourceId)!]));
	}

	const reservedEntries = reservedPaths.map((path, index) => ({
		sourceId: `!reserved-${index}-${path}`,
		displayName: path,
	}));
	const allocated = allocateIdPathSegments([...entries, ...reservedEntries]);
	return new Map(entries.map(({ sourceId }) => [sourceId, allocated.get(sourceId)!]));
}

function normalizeFieldLabel(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/gu, '')
		.toLocaleLowerCase('en-US')
		.replace(/ß/gu, 'ss');
}

function normalizeFieldHeader(value: string): string {
	return normalizeFieldLabel(value)
		.replace(/[^a-z0-9]+/gu, ' ')
		.trim();
}

const COMBINED_LESSON_DETAILS_HEADER = normalizeFieldHeader(
	'Thema Datum / Inhalt (wenn hinterlegt) / Hausaufgaben (wenn hinterlegt)',
);

function isTimetablePeriodHeader(header: string): boolean {
	const normalized = normalizeFieldHeader(header);
	return normalized === 'stunde' || normalized === 'period';
}

function getVerifiedTimetablePeriodNumber(value: string): string | null {
	const normalized = value.replace(/\s+/gu, ' ').trim();
	const match =
		/^\s*(\d{1,2})(?:(?:\s*\(\s*((?:[01]?\d|2[0-3]):[0-5]\d)\s*[-–—]\s*((?:[01]?\d|2[0-3]):[0-5]\d)\s*\))|(?:\s+((?:[01]?\d|2[0-3]):[0-5]\d)\s*[-–—]\s*((?:[01]?\d|2[0-3]):[0-5]\d)(?:\s+(\d{1,2})\.)?))?$/u.exec(
			normalized,
		);
	if (!match) {
		return null;
	}

	const period = Number(match[1]);
	if (!Number.isSafeInteger(period) || period < 1 || (match[6] !== undefined && Number(match[6]) !== period)) {
		return null;
	}

	const startTime = match[2] ?? match[4];
	const endTime = match[3] ?? match[5];
	if (startTime && endTime) {
		const [startHour, startMinute] = startTime.split(':').map(Number);
		const [endHour, endMinute] = endTime.split(':').map(Number);
		if (
			startHour === undefined ||
			startMinute === undefined ||
			endHour === undefined ||
			endMinute === undefined ||
			startHour * 60 + startMinute >= endHour * 60 + endMinute
		) {
			return null;
		}
	}

	return String(period);
}

function getRecordTimetablePeriodNumber(record: PortalRecord): string | null {
	if (record.format !== 'html') {
		return null;
	}
	const periodFields = record.fields.filter(
		field => typeof field.header === 'string' && isTimetablePeriodHeader(field.header),
	);
	return periodFields.length === 1 ? getVerifiedTimetablePeriodNumber(periodFields[0].text) : null;
}

function getTimetableLessonIds(records: readonly PortalRecord[]): string[] {
	const occurrences = new Map<string, number>();
	return records.map((record, index) => {
		const period = getRecordTimetablePeriodNumber(record);
		if (period !== null) {
			const base = period.padStart(2, '0');
			const occurrence = (occurrences.get(base) ?? 0) + 1;
			occurrences.set(base, occurrence);
			return occurrence === 1 ? base : `${base}_${occurrence}`;
		}
		return `lesson_${String(index + 1).padStart(2, '0')}`;
	});
}

function getFieldId(label: string, index: number, usedIds: Set<string>): string {
	const base =
		normalizeFieldLabel(label)
			.replace(/[^a-z0-9]+/gu, '_')
			.replace(/^_+|_+$/gu, '')
			.slice(0, 64)
			.replace(/_+$/gu, '') || `column_${String(index + 1).padStart(2, '0')}`;
	let suffix = 1;
	let candidate = base;
	while (usedIds.has(candidate)) {
		suffix++;
		candidate = `${base.slice(0, 64 - String(suffix).length - 1)}_${suffix}`;
	}
	usedIds.add(candidate);
	return candidate;
}

const PORTAL_COLUMN_ALIASES = new Map<string, string>([
	...Object.entries(SUBSTITUTION_COLUMN_ALIASES),
	['datum', 'date'],
	['wochentag', 'weekday'],
	['tag', 'day'],
	['kurs', 'course'],
	['weiteres', 'additional information'],
	['anwesend', 'present'],
	['entschuldigt', 'excused'],
	['andere schulische veranstaltung', 'other school event'],
	[COMBINED_LESSON_DETAILS_HEADER, 'lesson details'],
]);

const KNOWN_ENGLISH_COLUMN_HEADERS = new Set([
	...PORTAL_COLUMN_ALIASES.values(),
	'assessment',
	'course name',
	'description',
	'end',
	'end time',
	'entry',
	'homework',
	'item',
	'lesson',
	'mark',
	'name',
	'start',
	'start time',
	'time',
	'title',
	'topic',
]);

function getColumnDescriptor(
	header: string | null,
	index: number,
	value: string,
	usedIds: Set<string>,
	previousIds: Set<string>,
): RecordFieldDescriptor {
	const normalized = normalizeFieldHeader(header ?? '');
	const alias = PORTAL_COLUMN_ALIASES.get(normalized);
	const knownName = alias
		? `${alias[0].toUpperCase()}${alias.slice(1)}`
		: header && KNOWN_ENGLISH_COLUMN_HEADERS.has(normalized)
			? header.trim()
			: undefined;
	const name = knownName ?? `Column ${index + 1}`;
	const columnId = `column_${String(index + 1).padStart(2, '0')}`;
	const id = getFieldId(knownName ?? columnId, index, usedIds);
	const previousId = getFieldId(header?.trim() ? header : columnId, index, previousIds);
	return { id, previousId, name, value, type: 'string', role: 'text' };
}

function getRecordFieldDescriptors(record: PortalRecord, resource?: PortalResourceKind): RecordFieldDescriptor[] {
	const usedIds = new Set<string>();
	if (record.format === 'html') {
		const previousIds = new Set<string>();
		const timetablePeriodNumber = resource === 'timetable' ? getRecordTimetablePeriodNumber(record) : null;
		return record.fields.flatMap((field, index) => {
			const isPeriodField =
				resource === 'timetable' && field.header !== null && isTimetablePeriodHeader(field.header);
			const value = isPeriodField ? timetablePeriodNumber : field.text;
			return typeof value === 'string'
				? [getColumnDescriptor(field.header, index, value, usedIds, previousIds)]
				: [];
		});
	}

	const descriptors = Object.entries(record.fields).map<RecordFieldDescriptor>(([key, value], index) => {
		let stateValue: string | number | boolean;
		let type: ioBroker.CommonType;
		let role: string;
		if (value === null) {
			stateValue = 'null';
			type = 'string';
			role = 'json';
		} else if (typeof value === 'string') {
			stateValue = value;
			type = 'string';
			role = 'text';
		} else if (typeof value === 'boolean') {
			stateValue = value;
			type = 'boolean';
			role = 'indicator';
		} else if (typeof value === 'number' && Number.isFinite(value)) {
			stateValue = value;
			type = 'number';
			role = 'value';
		} else {
			const serialized = JSON.stringify(value);
			if (typeof serialized !== 'string') {
				throw new Error('Invalid JSON record field');
			}
			stateValue = serialized;
			type = 'string';
			role = 'json';
		}
		return {
			id: getFieldId(key, index, usedIds),
			name: key,
			value: stateValue,
			type,
			role,
		};
	});

	const columns = resource === 'substitutions' ? record.fields.columns : undefined;
	if (!Array.isArray(columns)) {
		return descriptors;
	}

	const previousIds = new Set(usedIds);
	columns.forEach((column, index) => {
		if (typeof column !== 'object' || column === null || Array.isArray(column)) {
			return;
		}
		const columnRecord = column as Record<string, unknown>;
		if (typeof columnRecord.value !== 'string') {
			return;
		}
		const header = typeof columnRecord.header === 'string' ? columnRecord.header : null;
		descriptors.push(getColumnDescriptor(header, index, columnRecord.value, usedIds, previousIds));
	});
	return descriptors;
}

function getRecordDateFields(record: PortalRecord): string[] | null {
	if (record.format !== 'html') {
		return null;
	}
	const fields = record.fields.filter(field => {
		if (typeof field.header !== 'string') {
			return false;
		}
		const label = normalizeFieldLabel(field.header);
		return /date|datum|weekday|wochentag/u.test(label) || /(^|[^a-z])(day|tag)([^a-z]|$)/u.test(label);
	});
	return fields.length > 0 ? fields.map(field => field.text) : null;
}

function hasExplicitDateSyntax(value: string): boolean {
	return /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/u.test(value);
}

function getExplicitDate(value: string): string | null {
	const iso = value.match(/(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:$|\D)/u);
	const european = value.match(/(?:^|\D)(\d{1,2})\.(\d{1,2})\.(\d{4})(?:$|\D)/u);
	const parts = iso
		? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
		: european
			? [Number(european[3]), Number(european[2]), Number(european[1])]
			: null;
	if (!parts) {
		return null;
	}
	const [year, month, day] = parts;
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return null;
	}
	return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function getWeekday(value: string): TimetableWeekdayId | null {
	const token = normalizeFieldLabel(value.trim()).match(/^[a-z]+/u)?.[0];
	return TIMETABLE_WEEKDAYS.find(day => day.names.includes(token ?? ''))?.id ?? null;
}

function getDateWeekday(date: string): TimetableWeekdayId {
	const dayIndex = new Date(`${date}T00:00:00.000Z`).getUTCDay();
	return TIMETABLE_WEEKDAYS[(dayIndex + 6) % 7].id;
}

function getNextWeekdayDate(today: string, weekday: TimetableWeekdayId): string {
	const start = new Date(`${today}T00:00:00.000Z`);
	const startIndex = (start.getUTCDay() + 6) % 7;
	const targetIndex = TIMETABLE_WEEKDAYS.findIndex(day => day.id === weekday);
	start.setUTCDate(start.getUTCDate() + ((targetIndex - startIndex + 7) % 7));
	return `${start.getUTCFullYear().toString().padStart(4, '0')}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`;
}

function getRecordTimetableDate(record: PortalRecord, today: string): string | null {
	const contextualWeekday = record.context?.timetableWeekday ? getWeekday(record.context.timetableWeekday) : null;
	if (contextualWeekday) {
		return getNextWeekdayDate(today, contextualWeekday);
	}
	const dateFields = getRecordDateFields(record);
	if (!dateFields) {
		return null;
	}
	const explicitDates: string[] = [];
	const weekdays: TimetableWeekdayId[] = [];
	for (const value of dateFields) {
		const date = getExplicitDate(value);
		const weekday = getWeekday(value);
		if ((!date && hasExplicitDateSyntax(value)) || (!date && !weekday)) {
			return null;
		}
		if (date) {
			explicitDates.push(date);
		}
		if (weekday) {
			weekdays.push(weekday);
		}
	}
	if (explicitDates.length > 0) {
		const date = explicitDates[0];
		if (explicitDates.some(value => value !== date) || weekdays.some(value => value !== getDateWeekday(date))) {
			return null;
		}
		return date < today ? getNextWeekdayDate(today, getDateWeekday(date)) : date;
	}
	const weekday = weekdays[0];
	if (!weekday || weekdays.some(value => value !== weekday)) {
		return null;
	}
	return getNextWeekdayDate(today, weekday);
}

function groupTimetableRecords(records: readonly PortalRecord[], today: string): TimetableBuckets | null {
	const week: TimetableBuckets['week'] = {
		monday: [],
		tuesday: [],
		wednesday: [],
		thursday: [],
		friday: [],
		saturday: [],
		sunday: [],
	};
	const buckets: TimetableBuckets = { today: [], tomorrow: [], week };
	const start = new Date(`${today}T00:00:00.000Z`).getTime();
	for (const record of records) {
		const date = getRecordTimetableDate(record, today);
		if (!date) {
			return null;
		}
		const offset = Math.floor((new Date(`${date}T00:00:00.000Z`).getTime() - start) / 86_400_000);
		if (offset < 0 || offset >= TIMETABLE_WEEKDAYS.length) {
			continue;
		}
		buckets.week[getDateWeekday(date)].push(record);
		if (offset === 0) {
			buckets.today.push(record);
		} else if (offset === 1) {
			buckets.tomorrow.push(record);
		}
	}
	return buckets;
}

function isChildLessonSectionId(value: string): value is ChildLessonSectionId {
	return Object.prototype.hasOwnProperty.call(CHILD_LESSON_SECTION_NAMES, value);
}

interface AccountRefreshOutcome {
	connected: boolean;
	degraded: boolean;
	updated: boolean;
	lastError: string;
}

class CredentialUnavailableError extends Error {
	constructor() {
		super('Credential unavailable');
		this.name = 'CredentialUnavailableError';
	}
}

/** ioBroker runtime implementation for the read-only Schulportal Hessen adapter. */
export class SchulportalHessenAdapter extends utils.Adapter {
	private readonly refreshCoordinator = new RefreshCoordinator();
	private readonly activeSessions = new Set<PortalSession>();
	private refreshTimer: ioBroker.Timeout | undefined;
	private activeRefresh: Promise<void> | null = null;
	private schoolOptionsCache: { expiresAt: number; options: SchoolOption[] } | null = null;
	private schoolOptionsPromise: Promise<SchoolOption[]> | null = null;
	private unloading = false;

	/**
	 * Construct the adapter instance.
	 *
	 * @param options Optional ioBroker adapter options.
	 */
	constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({ ...options, name: 'schulportal-hessen' });
		this.on('ready', this.onReady.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	private onMessage(message: ioBroker.Message): void {
		if (message.command !== 'searchSchools' || !message.callback) {
			return;
		}
		const callback = message.callback;
		const payload = message.message;
		const query =
			typeof payload === 'object' && payload !== null ? (payload as { query?: unknown }).query : undefined;
		this.log.debug(
			`Admin requested school search (query length: ${typeof query === 'string' ? query.trim().length : 0}).`,
		);
		void this.getSchoolOptions().then(
			cachedOptions => {
				const matches = searchSchoolOptions(cachedOptions, query);
				this.log.debug(`School directory search returned ${matches.length} result(s).`);
				this.sendTo(message.from, message.command, matches, callback);
			},
			() => {
				this.log.warn('Unable to load the public Schulportal school directory.');
				this.sendTo(message.from, message.command, [], callback);
			},
		);
	}

	private async getSchoolOptions(): Promise<SchoolOption[]> {
		if (this.schoolOptionsCache && this.schoolOptionsCache.expiresAt > Date.now()) {
			return this.schoolOptionsCache.options;
		}
		if (this.schoolOptionsPromise) {
			return this.schoolOptionsPromise;
		}

		const request = fetchSchoolOptions().then(options => {
			this.schoolOptionsCache = { expiresAt: Date.now() + SCHOOL_OPTIONS_CACHE_MS, options };
			return options;
		});
		this.schoolOptionsPromise = request;
		try {
			return await request;
		} finally {
			if (this.schoolOptionsPromise === request) {
				this.schoolOptionsPromise = null;
			}
		}
	}

	private async onReady(): Promise<void> {
		const configErrors = validateAdapterConfig(this.config);
		const recoverableSchoolSearchConfig = hasOnlyRecoverableSchoolSearchErrors(configErrors);
		if (configErrors.length > 0 && !recoverableSchoolSearchConfig) {
			this.log.error(`Invalid adapter configuration: ${configErrors.join('; ')}`);
			this.terminate('Invalid adapter configuration', utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			return;
		}

		try {
			await this.createObjectTree();
			if (this.unloading) {
				return;
			}
			if (recoverableSchoolSearchConfig) {
				const code = configErrors.includes(RECOVERABLE_SCHOOL_ID_ERROR)
					? 'invalid-school-id'
					: 'account-config-incomplete';
				await this.setInvalidConfigStatus(code);
				return;
			}
			this.subscribeStates(REFRESH_STATE);
			if (!this.hasConfiguredAccount()) {
				await this.setNotConfiguredStatus();
				return;
			}
			await this.requestRefresh().catch(() => this.log.warn('Initial portal refresh failed.'));
		} catch {
			this.log.error('Adapter initialization failed.');
			this.terminate('Adapter initialization failed', utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
		}
	}

	private async createObjectTree(): Promise<void> {
		const configured = this.hasConfiguredAccount();
		const accountStatus = configured ? 'not-updated' : 'not-configured';

		await this.ensureChannel('info', 'Adapter information');
		await this.ensureState(ROOT_CONNECTION_STATE, 'Account connected', 'boolean', 'indicator.connected', false);
		await this.ensureState(
			ROOT_STATUS_STATE,
			'Overall status',
			'string',
			'text',
			configured ? 'initializing' : 'not-configured',
		);
		await this.ensureState(ACCOUNT_NAME_STATE, 'Account display name', 'string', 'text', '');
		await this.setAckState(ACCOUNT_NAME_STATE, this.config.accountName?.trim() ?? '');
		await this.ensureState(ACCOUNT_TYPE_STATE, 'Account type', 'string', 'text', '');
		await this.ensureState(ROOT_LAST_UPDATE_STATE, 'Last successful data update', 'number', 'value.time', 0, 'ms');
		await this.ensureState(REFRESH_STATE, 'Refresh now', 'boolean', 'button', false, undefined, true);
		await this.ensureState(ROOT_LAST_ERROR_STATE, 'Last safe error code', 'string', 'text', '');
		await this.ensureChannel('profile', 'Profile');
		await this.ensureState('profile.name', 'Name', 'string', 'text', '');
		await this.ensureState('profile.school', 'School', 'string', 'text', '');
		await this.ensureChannel('calendar', 'Calendar');
		await this.ensureChannel(INBOX_BASE, 'Inbox');
		await this.ensureChannel(STUDENTS_BASE, 'Students');
		for (const resource of Object.keys(RESOURCE_NAMES) as PortalResourceKind[]) {
			await this.createResourceTree(resource, accountStatus, undefined, undefined, resource !== 'timetable');
		}
	}

	private hasConfiguredAccount(): boolean {
		return Boolean(this.config.schoolId && this.config.credentialId);
	}

	private getBerlinToday(): string {
		return getPortalDateWindow().today;
	}

	private async setInvalidConfigStatus(code: 'invalid-school-id' | 'account-config-incomplete'): Promise<void> {
		if (this.unloading) {
			return;
		}
		await this.setAckState(ROOT_CONNECTION_STATE, false);
		await this.setAckState(ROOT_STATUS_STATE, 'invalid-config');
		await this.setAckState(ROOT_LAST_ERROR_STATE, code);
		for (const resource of Object.keys(RESOURCE_NAMES) as PortalResourceKind[]) {
			await this.setResourceStatus(resource, 'invalid-config');
		}
	}

	private async setNotConfiguredStatus(): Promise<void> {
		if (this.unloading) {
			return;
		}
		await this.setAckState(ROOT_CONNECTION_STATE, false);
		await this.setAckState(ROOT_STATUS_STATE, 'not-configured');
		await this.setAckState(ROOT_LAST_ERROR_STATE, '');
		for (const resource of Object.keys(RESOURCE_NAMES) as PortalResourceKind[]) {
			await this.setResourceStatus(resource, 'not-configured');
		}
	}

	private async setResourceStatus(resource: PortalResourceKind, status: string): Promise<void> {
		await this.setAckState(`${getResourceBase(resource)}.status`, status);
		if (resource === 'messages') {
			for (const category of INBOX_CATEGORIES) {
				await this.setAckState(`${INBOX_BASE}.${category}.status`, status);
			}
		}
	}

	private async commitAccountSummary(records: readonly PortalRecord[]): Promise<void> {
		await this.setAckState(ACCOUNT_TYPE_STATE, getAccountType(records));
		await this.setAckState('profile.name', getProfileFieldValue(records, ['name', 'fullname']));
		await this.setAckState('profile.school', getProfileFieldValue(records, ['school', 'schule']));
	}

	private async createResourceTree(
		resource: PortalResourceKind,
		initialStatus: string,
		base = getResourceBase(resource),
		name = RESOURCE_NAMES[resource],
		includeDataStates = true,
	): Promise<void> {
		await this.ensureChannel(base, name);
		await this.ensureState(`${base}.status`, 'Data area status', 'string', 'text', initialStatus);
		if (!includeDataStates) {
			return;
		}
		await this.ensureState(`${base}.count`, 'Record count', 'number', 'value', 0);
		if (resource === 'messages') {
			await this.ensureState(`${base}.unreadCount`, 'Unread message count', 'number', 'value', 0);
		}
		await this.ensureState(`${base}.lastUpdate`, 'Last successful data update', 'number', 'value.time', 0, 'ms');
		await this.ensureState(`${base}.json`, 'Complete data (JSON)', 'string', 'json', '[]');
		if (resource === 'messages' && base === INBOX_BASE) {
			for (const category of INBOX_CATEGORIES) {
				const categoryBase = `${INBOX_BASE}.${category}`;
				const categoryName = category === 'read' ? 'Read messages' : 'Unread messages';
				await this.createResourceTree('messages', 'not-updated', categoryBase, categoryName, true);
			}
			return;
		}
		await this.ensureState(`${base}.recordIds`, 'Internal record manifest (JSON)', 'string', 'json', '[]');
		await this.ensureState(`${base}.recordPaths`, 'Internal record path mapping (JSON)', 'string', 'json', '{}');
		if (resource === 'substitutions' && base === getResourceBase(resource)) {
			await this.ensureState(
				`${base}.dailyJsonDates`,
				'Internal daily substitution JSON date manifest (JSON)',
				'string',
				'json',
				'[]',
			);
		}
	}

	private async ensureChannel(id: string, name: string): Promise<void> {
		await this.ensureObject(id, { type: 'channel', common: { name }, native: {} });
	}

	private async ensureChildChannel(id: string, name: string, legacyObjectId?: string): Promise<void> {
		const existing = await this.getObjectAsync(id);
		if (!existing) {
			const legacyObject = legacyObjectId ? await this.getObjectAsync(legacyObjectId) : null;
			const legacyName = legacyObject?.common.name;
			const generatedLegacyName = legacyObject?.native?.portalChildDisplayName;
			const objectName =
				typeof legacyName === 'string' &&
				typeof generatedLegacyName === 'string' &&
				legacyName !== generatedLegacyName
					? legacyName
					: name;
			await this.setObjectNotExistsAsync(id, {
				type: 'channel',
				common: { name: objectName },
				native: { portalChildDisplayName: name },
			});
			return;
		}

		const updatedName = getGeneratedObjectNameUpdate(
			existing.common.name,
			existing.native?.portalChildDisplayName,
			name,
		);
		if (updatedName) {
			await this.extendObjectAsync(id, {
				common: { name: updatedName },
				native: { portalChildDisplayName: updatedName },
			});
		}
	}

	private async ensureObject(id: string, object: ioBroker.SettableObject): Promise<void> {
		await this.setObjectNotExistsAsync(id, object);
	}

	private async ensureState(
		id: string,
		name: string,
		type: ioBroker.CommonType,
		role: string,
		defaultValue: string | number | boolean,
		unit?: string,
		write = false,
	): Promise<void> {
		await this.setObjectNotExistsAsync(id, {
			type: 'state',
			common: {
				name,
				type,
				role,
				read: !write,
				write,
				def: defaultValue,
				...(unit ? { unit } : {}),
			},
			native: {},
		});
		if (!(await this.getStateAsync(id))) {
			await this.setAckState(id, defaultValue);
		}
	}

	private async setAckState(id: string, value: string | number | boolean): Promise<void> {
		await this.setStateAsync(id, { val: value, ack: true });
	}

	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if ((id !== REFRESH_STATE && id !== `${this.namespace}.${REFRESH_STATE}`) || !state || state.ack !== false) {
			return;
		}
		void this.setAckState(REFRESH_STATE, false).catch(() => this.log.warn('Could not acknowledge manual refresh.'));
		if (state.val === true) {
			void this.requestRefresh().catch(() => this.log.warn('Manual portal refresh failed.'));
		}
	}

	private requestRefresh(): Promise<void> {
		if (this.unloading) {
			return Promise.resolve();
		}
		if (this.activeRefresh) {
			return this.activeRefresh;
		}
		this.cancelRefreshTimer();
		const refresh = this.refreshCoordinator.run(async () => {
			if (!this.unloading) {
				await this.setAckState(ROOT_STATUS_STATE, 'updating');
				if (!this.unloading) {
					await this.refreshAccount();
				}
			}
		});
		this.activeRefresh = refresh;
		const onSettled = (): void => {
			this.activeRefresh = null;
			if (!this.unloading && this.hasConfiguredAccount()) {
				const intervalMinutes = this.config.refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES;
				this.refreshTimer = this.setTimeout(() => {
					this.refreshTimer = undefined;
					void this.requestRefresh().catch(() => this.log.warn('Scheduled portal refresh failed.'));
				}, intervalMinutes * 60_000);
			}
		};
		void refresh.then(onSettled, onSettled);
		return refresh;
	}

	private cancelRefreshTimer(): void {
		if (this.refreshTimer !== undefined) {
			this.clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	private async refreshAccount(): Promise<void> {
		if (!this.hasConfiguredAccount()) {
			await this.setNotConfiguredStatus();
			return;
		}

		let outcome: AccountRefreshOutcome;
		try {
			outcome = await this.updateAccount(getPortalDateWindow());
		} catch {
			outcome = { connected: false, degraded: true, updated: false, lastError: 'internal-error' };
			await this.markAccountUnavailable('internal-error');
		}
		if (this.unloading) {
			return;
		}
		await this.setAckState(ROOT_CONNECTION_STATE, outcome.connected);
		await this.setAckState(
			ROOT_STATUS_STATE,
			outcome.connected ? (outcome.degraded ? 'partial' : 'connected') : 'disconnected',
		);
		if (outcome.updated) {
			await this.setAckState(ROOT_LAST_UPDATE_STATE, Date.now());
		}
	}

	private async updateAccount(dateWindow: ReturnType<typeof getPortalDateWindow>): Promise<AccountRefreshOutcome> {
		await this.setAckState(ROOT_CONNECTION_STATE, false);
		await this.setAckState(ROOT_STATUS_STATE, 'connecting');
		await this.setAckState(ROOT_LAST_ERROR_STATE, '');

		let session: PortalSession;
		try {
			const credentials = await utils.Credentials.getCredentials<utils.Credentials.LoginPasswordCredentials>(
				this,
				this.config.credentialId,
			);
			if (this.unloading) {
				return { connected: false, degraded: false, updated: false, lastError: '' };
			}
			if (
				typeof credentials.values.login !== 'string' ||
				credentials.values.login.length === 0 ||
				typeof credentials.values.password !== 'string' ||
				credentials.values.password.length === 0
			) {
				throw new CredentialUnavailableError();
			}
			session = new PortalSession({
				schoolId: this.config.schoolId,
				username: credentials.values.login,
				password: credentials.values.password,
			});
		} catch {
			await this.markAccountUnavailable('credential-unavailable');
			return { connected: false, degraded: true, updated: false, lastError: 'credential-unavailable' };
		}

		this.activeSessions.add(session);
		try {
			await session.authenticate();
			if (this.unloading) {
				return { connected: false, degraded: false, updated: false, lastError: '' };
			}
			await this.setAckState(ROOT_CONNECTION_STATE, true);
			const requests = createPortalResourceRequests(session, dateWindow);
			let successfulResources = 0;
			let degraded = false;
			let lastError = '';
			for (const request of requests) {
				if (this.unloading) {
					break;
				}
				const result = await this.refreshResource(request.id, request.read, request.parse);
				if (result.success) {
					successfulResources++;
				}
				if (result.degraded) {
					degraded = true;
					lastError ||= `${request.id}:${result.status}`;
				}
			}
			if (this.unloading) {
				return { connected: true, degraded, updated: successfulResources > 0, lastError };
			}
			const updated = successfulResources > 0;
			if (updated) {
				await this.setAckState(ROOT_LAST_UPDATE_STATE, Date.now());
			}
			await this.setAckState(ROOT_STATUS_STATE, degraded ? 'partial' : 'connected');
			await this.setAckState(ROOT_LAST_ERROR_STATE, lastError);
			return { connected: true, degraded, updated, lastError };
		} catch (error) {
			const portalError = error instanceof PortalSessionError ? error : undefined;
			const code = portalError?.code ?? 'internal-error';
			const status =
				code === 'authentication-failed' || code === 'handshake-failed' ? 'authentication-error' : code;
			const httpStatus =
				portalError?.httpStatus &&
				Number.isInteger(portalError.httpStatus) &&
				portalError.httpStatus >= 100 &&
				portalError.httpStatus <= 599
					? `http-${portalError.httpStatus}`
					: '';
			const lastError = [portalError?.diagnosticCode, httpStatus].filter(Boolean).join(':') || code;
			await this.markAccountUnavailable(status, lastError);
			return { connected: false, degraded: true, updated: false, lastError };
		} finally {
			session.close();
			this.activeSessions.delete(session);
		}
	}

	private async markAccountUnavailable(status: string, lastError = status): Promise<void> {
		if (this.unloading) {
			return;
		}
		await this.setAckState(ROOT_CONNECTION_STATE, false);
		await this.setAckState(ROOT_STATUS_STATE, status);
		await this.setAckState(ROOT_LAST_ERROR_STATE, lastError);
		for (const resource of Object.keys(RESOURCE_NAMES) as PortalResourceKind[]) {
			await this.setResourceStatus(resource, status);
		}
		const detail = lastError !== status ? ` (${lastError})` : '';
		this.log.warn(`Portal account: ${status}${detail}.`);
	}

	private async refreshResource(
		resource: PortalResourceKind,
		read: () => ReturnType<PortalSession['get']>,
		parse?: PortalResourceRequest['parse'],
	): Promise<{ success: boolean; degraded: boolean; status: string }> {
		const base = getResourceBase(resource);
		try {
			const response = await read();
			if (response.classification !== 'success') {
				const diagnosticCode =
					typeof response.diagnosticCode === 'string' && /^[a-z0-9-]{1,96}$/u.test(response.diagnosticCode)
						? response.diagnosticCode
						: undefined;
				const status = `${this.responseStatus(response.classification)}${diagnosticCode ? `:${diagnosticCode}` : ''}`;
				if (!this.unloading) {
					await this.setResourceStatus(resource, status);
					if (resource === 'timetable') {
						await this.removeUnconfirmedEmptyTimetableDefaults(base);
						await this.updateKnownChildTimetableStatuses(status);
					}
					if (diagnosticCode) {
						this.log.debug(`Portal data area ${resource} aggregation stopped (${diagnosticCode}).`);
					}
					if (response.classification === 'response-too-large') {
						this.log.debug(
							`Portal data area ${resource} response exceeded its configured limit (${formatOversizedResponseDiagnostic(response)}).`,
						);
					}
				}
				return { success: false, degraded: !this.isExpectedUnavailable(status), status };
			}

			const parsed = parse
				? parse(response.body, response.contentType)
				: parsePortalResource(
						resource,
						Buffer.from(response.body).toString('utf8'),
						response.contentType ?? undefined,
					);
			const children = parsed.status === 'complete' ? parsed.children : undefined;
			const childTimetables = parsed.status === 'complete' ? parsed.childTimetables : undefined;
			const childTimetablesValid =
				childTimetables === undefined ||
				(resource === 'timetable' && this.isParsedChildTimetables(childTimetables));
			const childMappingMismatch =
				childTimetablesValid &&
				childTimetables !== undefined &&
				!(await this.hasKnownTimetableChildren(childTimetables));
			const childPathMapping =
				childTimetables === undefined ? new Map<string, string>() : await this.readChildPathMapping();
			const timetableToday = childTimetables === undefined ? undefined : this.getBerlinToday();
			const childTimetableAssignments =
				childTimetablesValid && !childMappingMismatch && childTimetables !== undefined && timetableToday
					? childTimetables.map(child => ({
							child,
							childPath: childPathMapping.get(child.id) ?? child.id,
							buckets: groupTimetableRecords(child.records, timetableToday),
						}))
					: undefined;
			const childTimetableRowsUnassignable =
				childTimetableAssignments?.some(assignment => assignment.buckets === null) ?? false;
			const completeChildTimetableAssignments = childTimetableAssignments?.filter(
				(assignment): assignment is ChildTimetableAssignment => assignment.buckets !== null,
			);
			if (
				parsed.status !== 'complete' ||
				!this.isParsedRecordArray(parsed.records) ||
				(children !== undefined && (resource !== 'lessons' || !this.isParsedChildLessons(children))) ||
				!childTimetablesValid ||
				childMappingMismatch ||
				childTimetableRowsUnassignable
			) {
				const status = childMappingMismatch
					? 'invalid-response:unmatched-timetable-child'
					: childTimetableRowsUnassignable
						? 'invalid-response:unassignable-timetable-record'
						: parsed.status === 'unavailable'
							? parsed.reason
							: parsed.status === 'invalid'
								? `invalid-response:${parsed.reason}`
								: 'invalid-response:invalid-records';
				if (!this.unloading) {
					await this.setResourceStatus(resource, status);
					if (resource === 'timetable') {
						await this.removeUnconfirmedEmptyTimetableDefaults(base);
						await this.updateKnownChildTimetableStatuses(status);
					}
					if (
						resource === 'timetable' &&
						parsed.status === 'invalid' &&
						parsed.reason === 'timetable-sections-missing-with-tables'
					) {
						this.log.debug(
							`Portal timetable parser rejected response (${formatInvalidTimetableDiagnostic(response)}).`,
						);
					}
				}
				return { success: false, degraded: !this.isExpectedUnavailable(status), status };
			}

			if (this.unloading) {
				return { success: false, degraded: false, status: 'closed' };
			}
			if (resource === 'account') {
				await this.commitAccountSummary(parsed.records);
			}
			if (resource === 'timetable') {
				await this.createResourceTree('timetable', 'not-updated', base, 'Timetable', true);
			}
			const childCleanupPending =
				resource === 'lessons' && children !== undefined ? await this.commitChildLessons(children) : false;
			const childTimetableCleanupPending =
				resource === 'timetable' && completeChildTimetableAssignments !== undefined
					? await this.commitChildTimetables(completeChildTimetableAssignments)
					: false;
			const rootRecords =
				childTimetables !== undefined
					? []
					: resource === 'account'
						? parsed.records.filter(isProfileRecord)
						: resource === 'calendar' || resource === 'school-calendar'
							? parsed.records.filter(record => isCurrentCalendarEvent(record, this.getBerlinToday()))
							: parsed.records;
			const cleanupPending =
				resource === 'messages'
					? await this.commitMessageCategories(rootRecords)
					: await this.commitCompleteResource(resource, rootRecords);
			const cleanupPendingAny = cleanupPending || childCleanupPending || childTimetableCleanupPending;
			const status = cleanupPendingAny ? 'complete-cleanup-pending' : 'complete';
			const updatedAt = Date.now();
			await this.setResourceStatus(resource, status);
			await this.setAckState(`${base}.count`, rootRecords.length);
			await this.setAckState(`${base}.lastUpdate`, updatedAt);
			return { success: true, degraded: cleanupPendingAny, status };
		} catch (error) {
			const status =
				error instanceof PortalSessionError
					? error.diagnosticCode
						? `${error.code}:${error.diagnosticCode}`
						: error.code
					: 'request-error';
			if (!this.unloading) {
				await this.setResourceStatus(resource, status);
				if (resource === 'timetable') {
					await this.removeUnconfirmedEmptyTimetableDefaults(base);
					await this.updateKnownChildTimetableStatuses(status);
				}
				this.log.debug(`Portal data area ${resource} failed (${status}).`);
			}
			return { success: false, degraded: true, status };
		}
	}

	private isParsedRecordArray(records: unknown): records is readonly ParsedRecord[] {
		if (!Array.isArray(records)) {
			return false;
		}
		return records.every(
			record =>
				typeof record === 'object' &&
				record !== null &&
				!Array.isArray(record) &&
				typeof record.id === 'string' &&
				record.id.length > 0 &&
				record.id.length <= 4096,
		);
	}

	private isParsedChildLessons(children: unknown): children is readonly PortalChildLessons[] {
		if (!Array.isArray(children)) {
			return false;
		}
		const ids = new Set<string>();
		for (const value of children) {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return false;
			}
			const child = value as Record<string, unknown>;
			const childId = child.id;
			const records = child.records;
			const sections = child.sections;
			if (
				typeof childId !== 'string' ||
				!/^[a-f0-9]{64}$/u.test(childId) ||
				typeof child.name !== 'string' ||
				!child.name.trim() ||
				child.name.length > 256 ||
				!this.isParsedRecordArray(records) ||
				(sections !== undefined &&
					(!Array.isArray(sections) ||
						!sections.every(section => typeof section === 'string' && isChildLessonSectionId(section)) ||
						new Set(sections).size !== sections.length)) ||
				ids.has(childId)
			) {
				return false;
			}
			ids.add(childId);
			if (
				!records.every(
					record =>
						record.context?.childId === childId &&
						(record.format !== 'html' ||
							record.childSection === undefined ||
							isChildLessonSectionId(record.childSection)),
				)
			) {
				return false;
			}
		}
		return true;
	}

	private isParsedChildTimetables(children: unknown): children is readonly PortalChildTimetable[] {
		if (!Array.isArray(children)) {
			return false;
		}
		const ids = new Set<string>();
		const recordIds = new Set<string>();
		for (const value of children) {
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return false;
			}
			const child = value as Record<string, unknown>;
			const childId = child.id;
			const records = child.records;
			if (
				typeof childId !== 'string' ||
				!/^[a-f0-9]{64}$/u.test(childId) ||
				!this.isParsedRecordArray(records) ||
				ids.has(childId)
			) {
				return false;
			}
			const childRecordIds = new Set<string>();
			for (const record of records) {
				if (
					record.format !== 'html' ||
					record.section !== 'own' ||
					record.context?.childId !== childId ||
					recordIds.has(record.id) ||
					childRecordIds.has(record.id)
				) {
					return false;
				}
				childRecordIds.add(record.id);
			}
			ids.add(childId);
			for (const recordId of childRecordIds) {
				recordIds.add(recordId);
			}
		}
		return true;
	}

	private async readChildPathMapping(): Promise<Map<string, string>> {
		const state = await this.getStateAsync(`${STUDENTS_BASE}.pathMapping`);
		if (typeof state?.val !== 'string') {
			return new Map();
		}
		try {
			const value: unknown = JSON.parse(state.val);
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return new Map();
			}
			return new Map(
				Object.entries(value).filter(
					(entry): entry is [string, string] =>
						/^[a-f0-9]{64}$/u.test(entry[0]) &&
						typeof entry[1] === 'string' &&
						SAFE_READABLE_PATH_PATTERN.test(entry[1]),
				),
			);
		} catch {
			return new Map();
		}
	}

	private async writeChildPathMapping(mapping: ReadonlyMap<string, string>): Promise<void> {
		const value = Object.fromEntries(
			[...mapping].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		);
		await this.setAckState(`${STUDENTS_BASE}.pathMapping`, JSON.stringify(value));
	}

	private async readPendingChildTimetablePaths(): Promise<Map<string, string[]>> {
		const state = await this.getStateAsync(`${STUDENTS_BASE}.pendingTimetablePaths`);
		if (typeof state?.val !== 'string') {
			return new Map();
		}
		try {
			const value: unknown = JSON.parse(state.val);
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return new Map();
			}
			const paths = new Map<string, string[]>();
			for (const [sourceId, sourcePaths] of Object.entries(value)) {
				if (!/^[a-f0-9]{64}$/u.test(sourceId) || !Array.isArray(sourcePaths)) {
					continue;
				}
				paths.set(
					sourceId,
					[
						...new Set(
							sourcePaths.filter(
								(path): path is string =>
									typeof path === 'string' && SAFE_READABLE_PATH_PATTERN.test(path),
							),
						),
					].sort(),
				);
			}
			return paths;
		} catch {
			return new Map();
		}
	}

	private async writePendingChildTimetablePaths(paths: ReadonlyMap<string, readonly string[]>): Promise<void> {
		const value = Object.fromEntries(
			[...paths]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([sourceId, sourcePaths]) => [sourceId, [...new Set(sourcePaths)].sort()]),
		);
		await this.setAckState(`${STUDENTS_BASE}.pendingTimetablePaths`, JSON.stringify(value));
	}

	private async readRecordPathMapping(base: string): Promise<Map<string, string[]>> {
		const state = await this.getStateAsync(`${base}.recordPaths`);
		if (typeof state?.val !== 'string') {
			return new Map();
		}
		try {
			const value: unknown = JSON.parse(state.val);
			if (typeof value !== 'object' || value === null || Array.isArray(value)) {
				return new Map();
			}
			const paths = new Map<string, string[]>();
			for (const [sourceId, sourcePaths] of Object.entries(value)) {
				if (!RECORD_ID_PATTERN.test(sourceId)) {
					continue;
				}
				const candidates = typeof sourcePaths === 'string' ? [sourcePaths] : sourcePaths;
				if (!Array.isArray(candidates)) {
					continue;
				}
				const validPaths = [
					...new Set(
						candidates.filter(
							(path): path is string =>
								typeof path === 'string' && SAFE_READABLE_RECORD_PATH_PATTERN.test(path),
						),
					),
				].sort();
				if (validPaths.length > 0) {
					paths.set(sourceId, validPaths);
				}
			}
			return paths;
		} catch {
			return new Map();
		}
	}

	private async writeRecordPathMapping(base: string, mapping: ReadonlyMap<string, readonly string[]>): Promise<void> {
		const value = Object.fromEntries(
			[...mapping]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([sourceId, paths]) => [sourceId, [...new Set(paths)].sort()]),
		);
		await this.setAckState(`${base}.recordPaths`, JSON.stringify(value));
	}

	private async hasKnownTimetableChildren(children: readonly PortalChildTimetable[]): Promise<boolean> {
		const knownIds = new Set(await this.readRecordManifest(`${STUDENTS_BASE}.recordIds`));
		for (const sourceId of (await this.readPendingChildTimetablePaths()).keys()) {
			knownIds.add(sourceId);
		}
		return children.every(child => knownIds.has(child.id));
	}

	private async hasConfirmedTimetableData(base: string): Promise<boolean> {
		const [status, count, lastUpdate, json] = await Promise.all([
			this.getStateAsync(`${base}.status`),
			this.getStateAsync(`${base}.count`),
			this.getStateAsync(`${base}.lastUpdate`),
			this.getStateAsync(`${base}.json`),
		]);
		if (
			(status?.val === 'complete' || status?.val === 'complete-cleanup-pending') &&
			typeof lastUpdate?.val === 'number' &&
			lastUpdate.val > 0
		) {
			return true;
		}
		if (typeof count?.val === 'number' && count.val > 0) {
			return true;
		}
		if ((await this.readRecordManifest(`${base}.recordIds`)).length > 0) {
			return true;
		}
		if (typeof json?.val === 'string' && json.val !== '[]') {
			return true;
		}
		const timetableDays = ['today', 'tomorrow', ...TIMETABLE_WEEKDAYS.map(day => `week.${day.id}`)];
		for (const day of timetableDays) {
			if ((await this.readRecordManifest(`${base}.${day}.lessons.recordIds`)).length > 0) {
				return true;
			}
		}
		return false;
	}

	private async removeUnconfirmedEmptyTimetableDefaults(base: string): Promise<void> {
		try {
			const [status, count, lastUpdate, json, recordIds, recordPaths] = await Promise.all([
				this.getStateAsync(`${base}.status`),
				this.getStateAsync(`${base}.count`),
				this.getStateAsync(`${base}.lastUpdate`),
				this.getStateAsync(`${base}.json`),
				this.getStateAsync(`${base}.recordIds`),
				this.getStateAsync(`${base}.recordPaths`),
			]);
			if (
				status?.val === 'complete' ||
				status?.val === 'complete-cleanup-pending' ||
				count?.val !== 0 ||
				lastUpdate?.val !== 0 ||
				json?.val !== '[]' ||
				recordIds?.val !== '[]' ||
				(recordPaths?.val !== undefined && recordPaths.val !== '{}')
			) {
				return;
			}
			for (const stateId of ['count', 'lastUpdate', 'json', 'recordIds', 'recordPaths']) {
				try {
					await this.delObjectAsync(`${base}.${stateId}`);
				} catch {
					this.log.debug('Could not remove unconfirmed timetable defaults.');
				}
			}
		} catch {
			this.log.debug('Could not inspect timetable defaults.');
		}
	}

	private async updateKnownChildTimetableStatuses(status: string): Promise<void> {
		try {
			const childPaths = await this.readChildPathMapping();
			const childIds = new Set(await this.readRecordManifest(`${STUDENTS_BASE}.recordIds`));
			for (const childId of (await this.readPendingChildTimetablePaths()).keys()) {
				childIds.add(childId);
			}
			for (const childId of childIds) {
				try {
					const childBase = `${STUDENTS_BASE}.${childPaths.get(childId) ?? childId}`;
					const child = await this.getObjectAsync(childBase);
					if (child?.type !== 'channel') {
						continue;
					}
					const timetableBase = `${childBase}.timetable`;
					await this.removeUnconfirmedEmptyTimetableDefaults(timetableBase);
					await this.ensureChannel(timetableBase, 'Timetable');
					await this.ensureState(`${timetableBase}.status`, 'Data area status', 'string', 'text', status);
					await this.setAckState(`${timetableBase}.status`, status);
				} catch {
					this.log.debug('Could not update a child timetable status.');
				}
			}
		} catch {
			this.log.debug('Could not read verified child channels for timetable status updates.');
		}
	}

	private async commitChildTimetables(children: readonly ChildTimetableAssignment[]): Promise<boolean> {
		const pendingCleanup: Array<{ base: string; childId: string; currentIds: string[]; staleIds: string[] }> = [];
		const cleanupByChild = new Map(children.map(({ child }) => [child.id, false]));
		const updatedAt = Date.now();
		for (const { child, childPath, buckets } of children) {
			const timetableBase = `${STUDENTS_BASE}.${childPath}.timetable`;
			await this.createResourceTree('timetable', 'not-updated', timetableBase, 'Timetable');
			const previousIds = await this.readRecordManifest(`${timetableBase}.recordIds`);
			const currentRecordIds = child.records.map(record => toSafeDynamicRecordId(record.id));
			const resourcePlan = planDynamicRecordSync(previousIds, currentRecordIds, true);
			if (!resourcePlan) {
				throw new Error('Could not plan complete timetable record update');
			}
			const dataJson = JSON.stringify(child.records);
			if (typeof dataJson !== 'string') {
				throw new Error('Invalid timetable JSON data');
			}
			await this.setAckState(
				`${timetableBase}.recordIds`,
				JSON.stringify([...new Set([...previousIds, ...resourcePlan.currentIds])].sort()),
			);
			await this.setAckState(`${timetableBase}.json`, dataJson);

			await this.ensureChannel(`${timetableBase}.week`, 'Week');
			const dayGroups: Array<{ id: string; name: string; records: readonly PortalRecord[] }> = [
				{ id: 'today', name: 'Today', records: buckets.today },
				{ id: 'tomorrow', name: 'Tomorrow', records: buckets.tomorrow },
			];
			for (const day of TIMETABLE_WEEKDAYS) {
				dayGroups.push({
					id: `week.${day.id}`,
					name: `${day.id[0].toUpperCase()}${day.id.slice(1)}`,
					records: buckets.week[day.id],
				});
			}

			for (const day of dayGroups) {
				const dayBase = `${timetableBase}.${day.id}`;
				await this.ensureChannel(dayBase, day.name);
				await this.ensureState(`${dayBase}.lessonCount`, 'Lesson count', 'number', 'value', 0);
				await this.setAckState(`${dayBase}.lessonCount`, day.records.length);
				await this.ensureState(`${dayBase}.hasLessons`, 'Has lessons', 'boolean', 'indicator', false);
				await this.setAckState(`${dayBase}.hasLessons`, day.records.length > 0);
				const lessonsBase = `${dayBase}.lessons`;
				await this.ensureChannel(lessonsBase, 'Lessons');
				await this.ensureState(
					`${lessonsBase}.recordIds`,
					'Internal lesson manifest (JSON)',
					'string',
					'json',
					'[]',
				);
				const previousLessonIds = await this.readRecordManifest(`${lessonsBase}.recordIds`);
				const lessonIds = getTimetableLessonIds(day.records);
				const lessonPlan = planDynamicRecordSync(previousLessonIds, lessonIds, true);
				if (!lessonPlan) {
					throw new Error('Could not plan complete timetable lesson update');
				}
				await this.setAckState(
					`${lessonsBase}.recordIds`,
					JSON.stringify([...new Set([...previousLessonIds, ...lessonPlan.currentIds])].sort()),
				);
				for (let index = 0; index < day.records.length; index++) {
					const record = day.records[index];
					const lessonId = lessonIds[index];
					if (record && lessonId) {
						const recordSourceId = toSafeDynamicRecordId(record.id);
						const legacyRecordIds = [
							`${timetableBase}.${recordSourceId}`,
							`${timetableBase}.records.${recordSourceId}`,
						];
						const failed = await this.commitRecordChannel(
							lessonsBase,
							record,
							lessonId,
							legacyRecordIds,
							false,
							'timetable',
						);
						if (failed) {
							cleanupByChild.set(child.id, true);
						}
					}
				}
				pendingCleanup.push({ base: lessonsBase, childId: child.id, ...lessonPlan });
			}
			pendingCleanup.push({ base: timetableBase, childId: child.id, ...resourcePlan });
		}

		for (const plan of pendingCleanup) {
			const failed = await this.cleanStaleRecordChannels(plan.base, plan);
			cleanupByChild.set(plan.childId, Boolean(cleanupByChild.get(plan.childId)) || failed);
		}
		const failedChildPathCleanup = await this.cleanPendingChildTimetablePaths(children);
		for (const { child, childPath } of children) {
			const timetableBase = `${STUDENTS_BASE}.${childPath}.timetable`;
			try {
				await this.delObjectAsync(`${timetableBase}.records`, { recursive: true });
			} catch {
				cleanupByChild.set(child.id, true);
			}
			if (failedChildPathCleanup.has(child.id)) {
				cleanupByChild.set(child.id, true);
			}
			const childCleanupPending = cleanupByChild.get(child.id) ?? false;
			await this.setAckState(
				`${timetableBase}.status`,
				childCleanupPending ? 'complete-cleanup-pending' : 'complete',
			);
			await this.setAckState(`${timetableBase}.count`, child.records.length);
			await this.setAckState(`${timetableBase}.lastUpdate`, updatedAt);
		}
		return [...cleanupByChild.values()].some(Boolean);
	}

	private async cleanPendingChildTimetablePaths(children: readonly ChildTimetableAssignment[]): Promise<Set<string>> {
		const childBase = STUDENTS_BASE;
		const currentChildIds = new Set(await this.readRecordManifest(`${childBase}.recordIds`));
		const mapping = await this.readChildPathMapping();
		const pendingPaths = await this.readPendingChildTimetablePaths();
		const failedCleanup = new Set<string>();

		for (const { child, childPath } of children) {
			const remainingPaths: string[] = [];
			for (const oldPath of pendingPaths.get(child.id) ?? []) {
				if (oldPath === childPath) {
					continue;
				}
				const usedByAnotherChild = [...mapping].some(
					([sourceId, path]) => sourceId !== child.id && path === oldPath,
				);
				if (usedByAnotherChild) {
					remainingPaths.push(oldPath);
					failedCleanup.add(child.id);
					continue;
				}
				try {
					await this.delObjectAsync(`${childBase}.${oldPath}`, { recursive: true });
				} catch {
					remainingPaths.push(oldPath);
					failedCleanup.add(child.id);
				}
			}

			if (!currentChildIds.has(child.id) && remainingPaths.length === 0) {
				try {
					await this.delObjectAsync(`${childBase}.${childPath}`, { recursive: true });
					mapping.delete(child.id);
					pendingPaths.delete(child.id);
					continue;
				} catch {
					remainingPaths.push(childPath);
					failedCleanup.add(child.id);
				}
			}

			if (remainingPaths.length > 0) {
				pendingPaths.set(child.id, [...new Set(remainingPaths)].sort());
			} else {
				pendingPaths.delete(child.id);
			}
		}

		await this.writePendingChildTimetablePaths(pendingPaths);
		await this.writeChildPathMapping(mapping);
		return failedCleanup;
	}

	private getUnreadMessageCount(records: readonly ParsedRecord[]): number {
		return records.filter(record => {
			if (
				record.format !== 'json' ||
				typeof record.fields !== 'object' ||
				record.fields === null ||
				Array.isArray(record.fields)
			) {
				return false;
			}
			const fields = record.fields as Record<string, unknown>;
			return fields.unread === true && fields.hidden !== true;
		}).length;
	}

	private async commitMessageCategories(records: readonly ParsedRecord[]): Promise<boolean> {
		const base = getResourceBase('messages');
		await this.createResourceTree('messages', 'not-updated', base, 'Inbox', true);
		const categorized: Record<(typeof INBOX_CATEGORIES)[number], ParsedRecord[]> = { read: [], unread: [] };
		for (const record of records) {
			if (
				record.format !== 'json' ||
				typeof record.fields !== 'object' ||
				record.fields === null ||
				Array.isArray(record.fields)
			) {
				continue;
			}
			const unread = (record.fields as Record<string, unknown>).unread;
			if (unread === true) {
				categorized.unread.push(record);
			} else if (unread === false) {
				categorized.read.push(record);
			}
		}

		const updatedAt = Date.now();
		let cleanupPending = false;
		for (const category of INBOX_CATEGORIES) {
			const categoryBase = `${base}.${category}`;
			const categoryCleanupPending = await this.commitCompleteResource(
				'messages',
				categorized[category],
				categoryBase,
			);
			cleanupPending ||= categoryCleanupPending;
			await this.setAckState(
				`${categoryBase}.status`,
				categoryCleanupPending ? 'complete-cleanup-pending' : 'complete',
			);
			await this.setAckState(`${categoryBase}.count`, categorized[category].length);
			await this.setAckState(`${categoryBase}.lastUpdate`, updatedAt);
		}
		const dataJson = JSON.stringify(records);
		if (typeof dataJson !== 'string') {
			throw new Error('Invalid message header JSON');
		}
		await this.setAckState(`${base}.count`, records.length);
		await this.setAckState(`${base}.unreadCount`, this.getUnreadMessageCount(records));
		await this.setAckState(`${base}.lastUpdate`, updatedAt);
		await this.setAckState(`${base}.json`, dataJson);
		return cleanupPending;
	}

	private async commitChildLessons(children: readonly PortalChildLessons[]): Promise<boolean> {
		const base = STUDENTS_BASE;
		const manifestId = `${base}.recordIds`;
		const existingManifest = await this.getStateAsync(manifestId);
		if (children.length === 0 && typeof existingManifest?.val !== 'string') {
			return false;
		}

		await this.ensureChannel(base, 'Children');
		await this.ensureState(manifestId, 'Internal child manifest (JSON)', 'string', 'json', '[]');
		await this.ensureState(`${base}.pathMapping`, 'Internal child path mapping (JSON)', 'string', 'json', '{}');
		await this.ensureState(
			`${base}.pendingTimetablePaths`,
			'Internal pending timetable paths (JSON)',
			'string',
			'json',
			'{}',
		);
		const previousIds = await this.readRecordManifest(manifestId);
		const previousPaths = await this.readChildPathMapping();
		const previousPendingPaths = await this.readPendingChildTimetablePaths();
		const plan = planDynamicRecordSync(
			previousIds,
			children.map(child => child.id),
			true,
		);
		if (!plan) {
			return false;
		}

		const pathEntries = children.map(child => ({ sourceId: child.id, displayName: child.name }));
		const pathReservations = new Map<string, PathReservation>();
		for (const path of ['timetable', 'lessons', 'recordIds', 'pathMapping', 'pendingTimetablePaths']) {
			pathReservations.set(`reserved:${path}`, { ownerId: `reserved:${path}`, path, fixed: true });
		}
		const addPathReservation = async (sourceId: string, path: string): Promise<void> => {
			if (await this.getObjectAsync(`${base}.${path}`)) {
				pathReservations.set(`${sourceId}:${path}`, { ownerId: sourceId, path });
			}
		};
		for (const [sourceId, path] of previousPaths) {
			await addPathReservation(sourceId, path);
		}
		for (const sourceId of previousIds) {
			if (!previousPaths.has(sourceId)) {
				await addPathReservation(sourceId, sourceId);
			}
		}
		for (const [sourceId, paths] of previousPendingPaths) {
			for (const path of paths) {
				await addPathReservation(sourceId, path);
			}
		}
		for (const child of children) {
			if (!previousPaths.has(child.id)) {
				await addPathReservation(child.id, child.id);
			}
		}
		const childPaths = allocateSegmentsWithReservations(pathEntries, [...pathReservations.values()]);

		let cleanupPending = false;
		for (const child of children) {
			const childPath = childPaths.get(child.id)!;
			const oldPath = previousPaths.get(child.id) ?? child.id;
			const legacyChildBase = oldPath === childPath ? undefined : `${base}.${oldPath}`;
			const childBase = `${base}.${childPath}`;
			await this.ensureChildChannel(childBase, child.name, legacyChildBase);
			const updatedAt = Date.now();
			const infoBase = `${childBase}.info`;
			await this.ensureChannel(infoBase, 'Student information');
			await this.ensureState(`${infoBase}.id`, 'Readable student ID', 'string', 'text', '');
			await this.ensureState(`${infoBase}.name`, 'Student name', 'string', 'text', '');
			await this.ensureState(`${infoBase}.status`, 'Student data status', 'string', 'text', 'not-updated');
			await this.ensureState(
				`${infoBase}.lastUpdate`,
				'Last successful student update',
				'number',
				'value.time',
				0,
				'ms',
			);
			await this.setAckState(`${infoBase}.id`, childPath);
			await this.setAckState(`${infoBase}.name`, child.name);

			const timetableBase = `${childBase}.timetable`;
			await this.createResourceTree('timetable', 'not-updated', timetableBase, 'Timetable', false);
			if ((await this.getStateAsync(`${timetableBase}.status`))?.val === 'feature-unavailable') {
				await this.setAckState(`${timetableBase}.status`, 'not-updated');
			}
			await this.removeUnconfirmedEmptyTimetableDefaults(timetableBase);

			const lessonsBase = `${childBase}.lessons`;
			await this.createResourceTree('lessons', 'not-updated', lessonsBase, 'Lessons and assignments');
			const childCleanupPending = await this.commitCompleteResource('lessons', child.records, lessonsBase);
			const status = childCleanupPending ? 'complete-cleanup-pending' : 'complete';
			await this.setAckState(`${lessonsBase}.status`, status);
			await this.setAckState(`${lessonsBase}.count`, child.records.length);
			await this.setAckState(`${lessonsBase}.lastUpdate`, updatedAt);

			const sectionRecords = new Map<ChildLessonSectionId, PortalRecord[]>();
			for (const section of child.sections ?? []) {
				if (isChildLessonSectionId(section)) {
					sectionRecords.set(section, []);
				}
			}
			for (const record of child.records) {
				const section = getChildLessonSection(record);
				const records = sectionRecords.get(section) ?? [];
				records.push(record);
				sectionRecords.set(section, records);
			}

			const sectionManifestId = `${lessonsBase}.sectionIds`;
			await this.ensureState(
				sectionManifestId,
				'Internal lesson-section manifest (JSON)',
				'string',
				'json',
				'[]',
			);
			const previousSections = (await this.readRecordManifest(sectionManifestId)).filter(isChildLessonSectionId);
			const sectionPlan = planDynamicRecordSync(previousSections, [...sectionRecords.keys()], true);
			let sectionCleanupPending = false;
			if (!sectionPlan) {
				sectionCleanupPending = true;
			} else {
				await this.setAckState(
					sectionManifestId,
					JSON.stringify([...new Set([...previousSections, ...sectionPlan.currentIds])].sort()),
				);
				for (const [section, records] of sectionRecords) {
					const sectionBase = `${lessonsBase}.${section}`;
					await this.createResourceTree(
						'lessons',
						'not-updated',
						sectionBase,
						CHILD_LESSON_SECTION_NAMES[section],
					);
					const sectionNeedsCleanup = await this.commitCompleteResource('lessons', records, sectionBase);
					await this.setAckState(
						`${sectionBase}.status`,
						sectionNeedsCleanup ? 'complete-cleanup-pending' : 'complete',
					);
					await this.setAckState(`${sectionBase}.count`, records.length);
					await this.setAckState(`${sectionBase}.lastUpdate`, updatedAt);
					sectionCleanupPending ||= sectionNeedsCleanup;
				}
				const failedSectionDeletions: string[] = [];
				for (const section of sectionPlan.staleIds) {
					try {
						await this.delObjectAsync(`${lessonsBase}.${section}`, { recursive: true });
					} catch {
						failedSectionDeletions.push(section);
					}
				}
				await this.setAckState(
					sectionManifestId,
					JSON.stringify([...sectionPlan.currentIds, ...failedSectionDeletions].sort()),
				);
				sectionCleanupPending ||= failedSectionDeletions.length > 0;
			}

			const childHasCleanupPending = childCleanupPending || sectionCleanupPending;
			cleanupPending ||= childHasCleanupPending;
			await this.setAckState(
				`${infoBase}.status`,
				childHasCleanupPending ? 'complete-cleanup-pending' : 'complete',
			);
			await this.setAckState(`${infoBase}.lastUpdate`, updatedAt);
		}

		const childIds = new Set(plan.currentIds);
		const nextPathMapping = new Map<string, string>();
		const nextPendingPaths = new Map<string, string[]>();
		const previousSourceIds = new Set([
			...previousIds,
			...previousPaths.keys(),
			...previousPendingPaths.keys(),
			...plan.currentIds,
		]);
		for (const sourceId of previousSourceIds) {
			const currentPath = childPaths.get(sourceId);
			const oldPaths = new Set(previousPendingPaths.get(sourceId) ?? []);
			const mappedPath = previousPaths.get(sourceId);
			if (mappedPath) {
				oldPaths.add(mappedPath);
			} else if (
				(previousIds.includes(sourceId) || childIds.has(sourceId)) &&
				(await this.getObjectAsync(`${base}.${sourceId}`))
			) {
				oldPaths.add(sourceId);
			}

			const pendingForSource: string[] = [];
			for (const oldPath of oldPaths) {
				if (oldPath === currentPath || !(await this.getObjectAsync(`${base}.${oldPath}`))) {
					continue;
				}
				const oldChildBase = `${base}.${oldPath}`;
				const alreadyPending = (previousPendingPaths.get(sourceId) ?? []).includes(oldPath);
				const preserveTimetable =
					alreadyPending || (await this.hasConfirmedTimetableData(`${oldChildBase}.timetable`));
				if (preserveTimetable) {
					pendingForSource.push(oldPath);
					for (const suffix of ['info', 'lessons']) {
						try {
							await this.delObjectAsync(`${oldChildBase}.${suffix}`, { recursive: true });
						} catch {
							cleanupPending = true;
						}
					}
					continue;
				}
				try {
					await this.delObjectAsync(oldChildBase, { recursive: true });
				} catch {
					pendingForSource.push(oldPath);
					cleanupPending = true;
				}
			}

			if (currentPath) {
				nextPathMapping.set(sourceId, currentPath);
			} else if (pendingForSource.length > 0) {
				nextPathMapping.set(sourceId, mappedPath ?? pendingForSource[0]);
			}
			if (pendingForSource.length > 0) {
				nextPendingPaths.set(sourceId, [...new Set(pendingForSource)].sort());
			}
		}

		await this.writePendingChildTimetablePaths(nextPendingPaths);
		await this.writeChildPathMapping(nextPathMapping);
		await this.setAckState(manifestId, JSON.stringify(plan.currentIds));
		return cleanupPending || [...nextPendingPaths.keys()].some(sourceId => !childIds.has(sourceId));
	}

	private async commitRecordChannel(
		base: string,
		record: PortalRecord,
		recordSegment: string,
		legacyObjectIds: readonly string[] = [],
		compact = false,
		resource?: PortalResourceKind,
	): Promise<boolean> {
		const channelId = `${base}.${recordSegment}`;
		const displayName = getReadableRecordName(record, true);
		const generatedDisplayName =
			resource === 'timetable' && record.format === 'html' && record.section === 'own'
				? displayName.replace(/^Personal timetable — /u, '')
				: displayName;
		const existing = await this.getObjectAsync(channelId);
		let objectName = generatedDisplayName;
		if (!existing) {
			for (const legacyObjectId of legacyObjectIds) {
				if (legacyObjectId === channelId) {
					continue;
				}
				const legacyObject = await this.getObjectAsync(legacyObjectId);
				const legacyPath = legacyObjectId.startsWith(`${base}.`) ? legacyObjectId.slice(base.length + 1) : '';
				const isReservedFixedObject =
					!legacyPath.includes('.') &&
					getFixedResourceChildPaths(resource ?? 'file-metadata', base).some(
						path => path.toLowerCase() === legacyPath.toLowerCase(),
					);
				const hasRecordMetadata =
					typeof legacyObject?.native?.portalRecordDisplayName === 'string' ||
					Array.isArray(legacyObject?.native?.portalRecordFieldIds);
				const legacyName = isReservedFixedObject && !hasRecordMetadata ? undefined : legacyObject?.common?.name;
				if (
					typeof legacyName === 'string' &&
					legacyName !== legacyObject?.native?.portalRecordDisplayName &&
					legacyName !== `Record ${record.id}`
				) {
					objectName = legacyName;
					break;
				}
			}
		}
		if (!existing) {
			await this.setObjectNotExistsAsync(channelId, {
				type: 'channel',
				common: { name: objectName },
				native: { portalRecordDisplayName: generatedDisplayName, portalRecordFieldIds: [] },
			});
		}
		const existingName = existing?.common?.name;
		const nameUpdate = existing
			? (getGeneratedObjectNameUpdate(
					existingName,
					existing.native?.portalRecordDisplayName,
					generatedDisplayName,
				) ?? (existingName === `Record ${record.id}` ? generatedDisplayName : null))
			: null;
		const hasValidName =
			typeof existingName === 'string' ||
			(typeof existingName === 'object' &&
				existingName !== null &&
				!Array.isArray(existingName) &&
				typeof existingName.en === 'string' &&
				Object.values(existingName).every(value => typeof value === 'string'));
		await this.extendObjectAsync(channelId, {
			type: 'channel',
			common: { name: nameUpdate ?? (hasValidName ? existingName : objectName) },
			native: { portalRecordDisplayName: generatedDisplayName },
		});

		let descriptors: RecordFieldDescriptor[];
		if (compact) {
			const serializedRecord = JSON.stringify(record);
			if (typeof serializedRecord !== 'string') {
				throw new Error('Invalid JSON record');
			}
			descriptors = [
				{
					id: 'record_json',
					name: 'Complete record (JSON)',
					value: serializedRecord,
					type: 'string',
					role: 'json',
				},
			];
		} else {
			descriptors = getRecordFieldDescriptors(record, resource);
		}
		const previousFieldIds = Array.isArray(existing?.native?.portalRecordFieldIds)
			? existing.native.portalRecordFieldIds.filter(
					(value: unknown): value is string => typeof value === 'string' && RECORD_ID_PATTERN.test(value),
				)
			: [];
		const currentFieldIds = descriptors.map(field => field.id);
		for (const descriptor of descriptors) {
			const previousId = descriptor.previousId;
			const legacyId =
				previousId && previousFieldIds.includes(previousId) && !currentFieldIds.includes(previousId)
					? `${channelId}.${previousId}`
					: undefined;
			await this.commitRecordFieldState(`${channelId}.${descriptor.id}`, descriptor, legacyId);
		}
		const failedFieldDeletions: string[] = [];
		for (const fieldId of previousFieldIds) {
			if (currentFieldIds.includes(fieldId)) {
				continue;
			}
			try {
				await this.delObjectAsync(`${channelId}.${fieldId}`, { recursive: true });
			} catch {
				failedFieldDeletions.push(fieldId);
			}
		}

		await this.extendObjectAsync(channelId, {
			native: {
				portalRecordDisplayName: generatedDisplayName,
				portalRecordFieldIds: [...new Set([...currentFieldIds, ...failedFieldDeletions])].sort(),
			},
		});
		return failedFieldDeletions.length > 0;
	}

	private async commitRecordFieldState(
		id: string,
		descriptor: RecordFieldDescriptor,
		legacyId?: string,
	): Promise<void> {
		const existing = await this.getObjectAsync(id);
		if (!existing) {
			const legacy = legacyId ? await this.getObjectAsync(legacyId) : undefined;
			const previousName = legacy?.type === 'state' ? legacy.common.name : undefined;
			const previousGeneratedName = legacy?.native?.portalRecordFieldDisplayName;
			const name =
				previousName && typeof previousGeneratedName === 'string' && previousName !== previousGeneratedName
					? previousName
					: descriptor.name;
			await this.setObjectNotExistsAsync(id, {
				type: 'state',
				common: {
					name,
					type: descriptor.type,
					role: descriptor.role,
					read: true,
					write: false,
				},
				native: { portalRecordFieldDisplayName: descriptor.name },
			});
		} else {
			const nameUpdate = getGeneratedObjectNameUpdate(
				existing.common.name,
				existing.native?.portalRecordFieldDisplayName,
				descriptor.name,
			);
			await this.extendObjectAsync(id, {
				common: {
					...(nameUpdate ? { name: nameUpdate } : {}),
					type: descriptor.type,
					role: descriptor.role,
					read: true,
					write: false,
				},
				native: { portalRecordFieldDisplayName: descriptor.name },
			});
		}
		await this.setAckState(id, descriptor.value);
	}

	private async cleanStaleRecordChannels(
		base: string,
		plan: { currentIds: string[]; staleIds: string[] },
	): Promise<boolean> {
		const failedDeletions: string[] = [];
		for (const id of plan.staleIds) {
			try {
				await this.delObjectAsync(`${base}.${id}`, { recursive: true });
			} catch {
				failedDeletions.push(id);
			}
		}
		await this.setAckState(`${base}.recordIds`, JSON.stringify([...plan.currentIds, ...failedDeletions].sort()));
		return failedDeletions.length > 0;
	}

	private async cleanLegacyFieldsAtFixedPath(id: string, resource: PortalResourceKind): Promise<void> {
		const fixed = await this.getObjectAsync(id);
		const tracked: unknown = fixed?.native?.portalRecordFieldIds;
		if ((fixed?.type !== 'state' && fixed?.type !== 'channel') || !Array.isArray(tracked)) {
			return;
		}
		const protectedFields =
			fixed.type === 'channel'
				? new Set(getFixedResourceChildPaths(resource, id).map(path => path.toLowerCase()))
				: undefined;
		await this.cleanTrackedRecordFields(id, tracked, protectedFields);
	}

	private async cleanLegacyRecordAtCaseVariant(id: string): Promise<void> {
		const channel = await this.getObjectAsync(id);
		const tracked: unknown = channel?.native?.portalRecordFieldIds;
		if (
			channel?.type !== 'channel' ||
			channel._id !== `${this.namespace}.${id}` ||
			typeof channel.native?.portalRecordDisplayName !== 'string' ||
			!Array.isArray(tracked)
		) {
			return;
		}
		await this.cleanTrackedRecordFields(id, tracked);
		// The record may have user-created descendants, which are not ours to delete.
		await this.delObjectAsync(id);
	}

	private async cleanTrackedRecordFields(
		id: string,
		tracked: readonly unknown[],
		protectedFields?: ReadonlySet<string>,
	): Promise<void> {
		for (const field of new Set(tracked)) {
			if (
				typeof field !== 'string' ||
				!RECORD_ID_PATTERN.test(field) ||
				protectedFields?.has(field.toLowerCase())
			) {
				continue;
			}
			const childId = `${id}.${field}`;
			const child = await this.getObjectAsync(childId);
			if (
				child?.type === 'state' &&
				child._id === `${this.namespace}.${childId}` &&
				typeof child.native?.portalRecordFieldDisplayName === 'string'
			) {
				await this.delObjectAsync(childId);
			}
		}
	}

	private async commitCompleteResource(
		resource: PortalResourceKind,
		records: readonly ParsedRecord[],
		base = getResourceBase(resource),
	): Promise<boolean> {
		const manifestId = `${base}.recordIds`;
		const previousIds = await this.readRecordManifest(manifestId);
		const previousPaths = await this.readRecordPathMapping(base);
		const pathEntries = records.map(record => ({
			sourceId: toSafeDynamicRecordId(record.id),
			displayName: getReadableRecordPathName(resource, record),
		}));
		const plan = planDynamicRecordSync(
			previousIds,
			pathEntries.map(entry => entry.sourceId),
			true,
		);
		if (!plan) {
			return false;
		}
		const reservedDailyDates =
			resource === 'substitutions'
				? new Set([
						...(await this.readDailySubstitutionDates(`${base}.dailyJsonDates`)),
						...groupDailySubstitutionRows(records).keys(),
					])
				: new Set<string>();
		const fixedResourcePaths = new Set(getFixedResourceChildPaths(resource, base));
		const normalizedFixedPaths = new Set([...fixedResourcePaths].map(path => path.toLowerCase()));
		const reservedFixedPaths = new Set([...normalizedFixedPaths, ...reservedDailyDates]);
		const pathReservations: PathReservation[] = [...reservedFixedPaths].map((path, index) => ({
			ownerId: `fixed:${index}:${path}`,
			path,
			fixed: true,
		}));
		for (const sourceId of new Set([...previousIds, ...previousPaths.keys()])) {
			const paths = previousPaths.get(sourceId) ?? [sourceId];
			for (const path of paths) {
				if (await this.getObjectAsync(`${base}.${path}`)) {
					pathReservations.push({ ownerId: sourceId, path });
				}
			}
		}
		const currentPaths =
			resource === 'substitutions'
				? getSubstitutionRecordPaths(records)
				: allocateSegmentsWithReservations(pathEntries, pathReservations);
		const currentSegments = new Set([...currentPaths.values()].map(path => path.toLowerCase()));
		const dataJson = JSON.stringify(records);
		if (typeof dataJson !== 'string') {
			throw new Error('Invalid JSON data');
		}

		if (resource === 'substitutions') {
			const parentChannels = new Set([...currentPaths.values()].map(path => path.split('.')[0]));
			for (const parentChannel of parentChannels) {
				await this.ensureChannel(
					`${base}.${parentChannel}`,
					parentChannel === 'undated' ? 'Undated substitutions' : parentChannel,
				);
			}
		}

		await this.setAckState(manifestId, JSON.stringify([...new Set([...previousIds, ...plan.currentIds])].sort()));
		let cleanupPending = false;
		for (const record of records) {
			if (typeof JSON.stringify(record) !== 'string') {
				throw new Error('Invalid JSON record');
			}
			const sourceId = toSafeDynamicRecordId(record.id);
			const recordPath = currentPaths.get(sourceId);
			if (!recordPath) {
				throw new Error('Missing readable record path');
			}
			const legacyObjectIds = [
				`${base}.${sourceId}`,
				...(previousPaths.get(sourceId) ?? []).map(path => `${base}.${path}`),
				`${base}.records.${sourceId}`,
			];
			cleanupPending =
				(await this.commitRecordChannel(
					base,
					record,
					recordPath,
					[...new Set(legacyObjectIds)],
					isCompactRecordResource(resource),
					resource,
				)) || cleanupPending;
		}
		if (resource === 'substitutions') {
			cleanupPending = (await this.commitDailySubstitutionJson(records)) || cleanupPending;
		}
		await this.setAckState(`${base}.json`, dataJson);
		if (resource === 'messages') {
			await this.setAckState(`${base}.unreadCount`, this.getUnreadMessageCount(records));
		}

		const pathsToRemove = new Map<string, Set<string>>();
		const sourceIds = new Set([...previousIds, ...previousPaths.keys()]);
		for (const sourceId of sourceIds) {
			const currentPath = currentPaths.get(sourceId);
			const oldPaths = new Set(previousPaths.get(sourceId) ?? []);
			if ((previousIds.includes(sourceId) || previousPaths.has(sourceId)) && sourceId !== currentPath) {
				oldPaths.add(sourceId);
			}
			for (const oldPath of oldPaths) {
				const normalizedOldPath = oldPath.toLowerCase();
				const [root, child] = normalizedOldPath.split('.');
				if (
					currentSegments.has(normalizedOldPath) ||
					(child &&
						(normalizedFixedPaths.has(root) ||
							currentSegments.has(root) ||
							currentSegments.has(`${root}.${child}`))) ||
					(resource === 'substitutions' &&
						((root === 'undated' && !child) ||
							(reservedDailyDates.has(root) && (!child || child === 'json'))))
				) {
					continue;
				}
				try {
					const id = `${base}.${oldPath}`;
					if (fixedResourcePaths.has(oldPath)) {
						if (oldPath !== 'records') {
							await this.cleanLegacyFieldsAtFixedPath(id, resource);
						}
					} else if (normalizedFixedPaths.has(normalizedOldPath)) {
						if (previousPaths.get(sourceId)?.includes(oldPath) || previousIds.includes(sourceId)) {
							await this.cleanLegacyRecordAtCaseVariant(id);
						}
					} else {
						await this.delObjectAsync(id, { recursive: true });
					}
				} catch {
					cleanupPending = true;
					const failedPaths = pathsToRemove.get(sourceId) ?? new Set<string>();
					failedPaths.add(oldPath);
					pathsToRemove.set(sourceId, failedPaths);
				}
			}
		}
		if (!currentSegments.has('records')) {
			try {
				await this.delObjectAsync(`${base}.records`, { recursive: true });
			} catch {
				cleanupPending = true;
			}
		}

		const nextPaths = new Map<string, string[]>();
		for (const [sourceId, path] of currentPaths) {
			nextPaths.set(sourceId, [path, ...(pathsToRemove.get(sourceId) ?? [])]);
		}
		for (const [sourceId, paths] of pathsToRemove) {
			if (!currentPaths.has(sourceId)) {
				nextPaths.set(sourceId, [...paths]);
			}
		}
		const staleIdsPendingCleanup = [...pathsToRemove.keys()].filter(sourceId => !currentPaths.has(sourceId));
		await this.writeRecordPathMapping(base, nextPaths);
		await this.setAckState(
			manifestId,
			JSON.stringify([...new Set([...plan.currentIds, ...staleIdsPendingCleanup])].sort()),
		);
		return cleanupPending;
	}

	private async commitDailySubstitutionJson(records: readonly PortalRecord[]): Promise<boolean> {
		const base = getResourceBase('substitutions');
		const manifestId = `${base}.dailyJsonDates`;
		const previousDates = await this.readDailySubstitutionDates(manifestId);
		const groups = groupDailySubstitutionRows(records);
		const currentDates = [...groups.keys()].sort();
		for (const date of currentDates) {
			const channelId = `${base}.${date}`;
			await this.ensureChannel(channelId, date);
			const stateId = `${channelId}.json`;
			await this.ensureState(stateId, `Substitutions for ${date} (JSON)`, 'string', 'json', '[]');
			const dataJson = JSON.stringify(groups.get(date));
			if (typeof dataJson !== 'string') {
				throw new Error('Invalid daily substitution JSON');
			}
			await this.setAckState(stateId, dataJson);
		}

		const currentDateSet = new Set(currentDates);
		const failedDeletions: string[] = [];
		for (const date of previousDates) {
			if (currentDateSet.has(date)) {
				continue;
			}
			try {
				await this.delObjectAsync(`${base}.${date}`, { recursive: true });
			} catch {
				failedDeletions.push(date);
			}
		}
		await this.setAckState(manifestId, JSON.stringify([...new Set([...currentDates, ...failedDeletions])].sort()));
		return failedDeletions.length > 0;
	}

	private async readDailySubstitutionDates(id: string): Promise<string[]> {
		const state = await this.getStateAsync(id);
		if (typeof state?.val !== 'string') {
			return [];
		}
		try {
			const value: unknown = JSON.parse(state.val);
			return Array.isArray(value)
				? [
						...new Set(
							value.filter((date): date is string => typeof date === 'string' && isIsoCalendarDate(date)),
						),
					].sort()
				: [];
		} catch {
			return [];
		}
	}

	private async readRecordManifest(id: string): Promise<string[]> {
		const state = await this.getStateAsync(id);
		if (typeof state?.val !== 'string') {
			return [];
		}
		try {
			const value: unknown = JSON.parse(state.val);
			return Array.isArray(value)
				? value.filter((item): item is string => typeof item === 'string' && RECORD_ID_PATTERN.test(item))
				: [];
		} catch {
			return [];
		}
	}

	private responseStatus(classification: string): string {
		const statuses: Record<string, string> = {
			forbidden: 'permission-denied',
			'not-found': 'not-available',
			'rate-limited': 'rate-limited',
			'session-expired': 'authentication-failed',
			'response-too-large': 'response-too-large',
			'blocked-redirect': 'blocked-redirect',
			'redirect-limit': 'redirect-limit',
			'client-error': 'request-error',
			'server-error': 'server-error',
			redirect: 'redirect',
			unknown: 'unknown-response',
		};
		return statuses[classification] ?? 'request-error';
	}

	private isExpectedUnavailable(status: string): boolean {
		return (
			status === 'unavailable' ||
			status === 'permission-denied' ||
			status === 'feature-unavailable' ||
			status === 'not-available'
		);
	}

	private async onUnload(callback: () => void): Promise<void> {
		this.unloading = true;
		this.cancelRefreshTimer();
		for (const session of this.activeSessions) {
			session.close();
		}
		try {
			await this.activeRefresh;
		} catch {
			this.log.debug('An in-progress refresh ended during shutdown.');
		} finally {
			callback();
		}
	}
}
