import { createHash } from 'node:crypto';
import { parse, valid, type HTMLElement } from 'node-html-parser';

/** Verified page families and their source routes. */
export type PortalResourceKind =
	/** `/benutzerverwaltung.php?a=userData` */
	| 'account'
	/** Verified conversation headers and validated message detail records. */
	| 'messages'
	/** `/stundenplan.php` */
	| 'timetable'
	/** Verified own-plan tables or JSON day reads from `/vertretungsplan.php`. */
	| 'substitutions'
	/** Verified available-date listing from `/vertretungsplan.php`. */
	| 'substitution-dates'
	/** `/kalender.php` JSON getEvents response. */
	| 'calendar'
	/** Verified CSV/iCalendar export from `/kalender.php?a=export`. */
	| 'school-calendar'
	/** `/meinunterricht.php` */
	| 'lessons'
	/** `/lerngruppen.php` */
	| 'learning-groups'
	/** `/dateispeicher.php` */
	| 'file-metadata';

/** A visible link and its safe source metadata. */
export interface PortalLink {
	/** Safe same-origin relative path, or null when the URL is uncertain or sensitive. */
	href: string | null;
	/** Visible link text preserved from the page. */
	text: string;
	/** Non-sensitive source attributes; URL, token, and session-like attributes are omitted. */
	attributes: Readonly<Record<string, string>>;
}

/** A table cell with its visible value and contained links. */
export interface PortalCell {
	/** Source table header text, or null when no single header applies. */
	header: string | null;
	/** Visible cell text, preserving its source whitespace and date/time strings. */
	text: string;
	/** Links found in the cell, with sensitive URLs omitted. */
	links: readonly PortalLink[];
	/** Non-sensitive source cell attributes. */
	attributes: Readonly<Record<string, string>>;
}

/** Source context for records combined from related portal reads. */
export interface PortalRecordContext {
	/** Opaque identifier for the child whose lesson data contains this record. */
	childId?: string;
	/** Numeric course ID for a verified lesson detail read. */
	courseId?: string;
	/** Numeric parent folder ID for a file or folder entry. */
	parentFolderId?: string;
	/** Canonical weekday from a verified weekday-column timetable. */
	timetableWeekday?: string;
}

/** Verified parent-child lesson resource sections. */
export type ChildLessonSection = 'current' | 'assignments' | 'history' | 'attendance' | 'marks' | 'exams' | 'other';

/** Safe classifications for records from verified nested parent lesson panes. */
export type ChildLessonRecordSection = 'current' | 'assignments' | 'attendance' | 'other';

/** A preserved table row with a stable source or content-derived ID. */
export interface PortalHtmlRecord {
	/** Optional context added when combining verified detail or folder reads. */
	context?: PortalRecordContext;
	/** Optional section classification from a structurally verified nested parent lesson pane. */
	childSection?: ChildLessonRecordSection;
	/** Identifies records parsed from HTML table rows. */
	format: 'html';
	/** Opaque hash of a safe source identifier or normalized row content. */
	id: string;
	/** Verified section marker containing this row. */
	section: string;
	/** Non-sensitive source row attributes. */
	attributes: Readonly<Record<string, string>>;
	/** Row cells in source order. */
	fields: readonly PortalCell[];
	/** Verified display-only lesson class markers. */
	markers?: readonly ('homework' | 'realHomework' | 'undone')[];
	/** Numeric course detail reference extracted from an exact verified detail link. */
	courseId?: string;
}

/** A preserved JSON record with its source fields. */
export interface PortalJsonRecord {
	/** Optional context added when combining verified detail or folder reads. */
	context?: PortalRecordContext;
	/** Identifies records parsed from a JSON array. */
	format: 'json';
	/** Explicit `id` value or opaque hash of normalized record content. */
	id: string;
	/** Original JSON properties and values, without semantic conversion. */
	fields: Readonly<Record<string, unknown>>;
}

/** A preserved source record from HTML or JSON. */
export type PortalRecord = PortalHtmlRecord | PortalJsonRecord;

/** Verified lesson data belonging to one parent-account child tab. */
export interface PortalChildLessons {
	/** Opaque hash of the source panel identifier. */
	id: string;
	/** Visible child label from the matching tab anchor. */
	name: string;
	/** Nested child sections with at least one structurally verified table. */
	sections?: readonly ChildLessonSection[];
	/** Lesson rows and detail rows scoped to this child only. */
	records: readonly PortalRecord[];
}

/** A verified parent timetable link for one child. */
export interface PortalTimetableChildLink {
	/** Opaque hash shared with the matching child lesson tab. */
	id: string;
	/** Validated same-origin request path; kept only in the in-memory aggregation. */
	requestPath: string;
}

/** A complete personal timetable result for one child. */
export interface PortalChildTimetable {
	/** Opaque hash shared with the matching child lesson tab. */
	id: string;
	/** Rows from the child's verified personal timetable table only. */
	records: readonly PortalRecord[];
}

/** Table headers and record membership for a verified page section. */
export interface PortalRecordGroup {
	/** Verified source section/table marker. */
	section: string;
	/** Non-sensitive source table attributes. */
	tableAttributes: Readonly<Record<string, string>>;
	/** Header rows in source order, including visible text and links. */
	headers: readonly (readonly PortalCell[])[];
	/** IDs of rows in this table, in source order. */
	recordIds: readonly string[];
}

/** Discriminated parser result; only complete results contain records. */
export type PortalParseResult =
	| {
			/** Expected structure recognized, including confirmed empty HTML tables. */
			status: 'complete';
			/** Requested verified page family. */
			kind: PortalResourceKind;
			/** Preserved source rows or records. */
			records: readonly PortalRecord[];
			/** HTML table sections and headers; empty for JSON record arrays. */
			groups: readonly PortalRecordGroup[];
			/** Per-child records when parsing a verified parent-account lesson page. */
			children?: readonly PortalChildLessons[];
			/** Child timetable links from a verified parent timetable index. */
			timetableChildren?: readonly PortalTimetableChildLink[];
			/** Completed child timetables from an aggregated parent request. */
			childTimetables?: readonly PortalChildTimetable[];
	  }
	| {
			/** Data requires login, permission, or an unsupported page layout. */
			status: 'unavailable';
			/** Requested verified page family. */
			kind: PortalResourceKind;
			/** Safe reason code; response content is not included. */
			reason:
				| 'login-required'
				| 'permission-denied'
				| 'feature-unavailable'
				| 'unsupported-html-structure'
				| 'substitution-whole-plan-button-present'
				| 'substitution-date-tags-missing'
				| 'substitution-date-count-exceeded'
				| 'substitution-vtable-tables-missing'
				| 'unrecognized-json-structure';
	  }
	| {
			/** Response was malformed or did not match the expected structure. */
			status: 'invalid';
			/** Requested verified page family. */
			kind: PortalResourceKind;
			/** Safe reason code; response content is not included. */
			reason:
				| 'invalid-input'
				| 'empty-response'
				| 'unsupported-content-type'
				| 'malformed-json'
				| 'malformed-csv'
				| 'malformed-icalendar'
				| 'malformed-html'
				| 'unexpected-html-structure'
				| 'timetable-sections-missing-with-tables'
				| 'timetable-sections-missing-no-tables'
				| 'timetable-tables-missing'
				| 'timetable-child-links-invalid'
				| 'lessons-sections-missing-with-tables'
				| 'lessons-sections-missing-no-tables'
				| 'lessons-tables-missing'
				| 'lessons-table-structure-invalid'
				| 'lessons-tabs-invalid'
				| 'duplicate-record-ids'
				| 'unexpected-calendar-structure'
				| 'invalid-json-records'
				| 'invalid-csv-records';
	  };

const TIMETABLE_SECTION_IDS = ['all', 'own'] as const;
const LESSON_SECTION_IDS = ['mappen', 'history', 'attendanceTable', 'marks', 'klausuren'] as const;
const SUBSTITUTION_HEADERS = ['', 'Stunde', 'Klasse', 'Vertretung', 'Lehrkraft', 'Fach', 'Raum', 'Hinweis'] as const;
const MAX_PARENT_CHILD_TABS = 20;
const CHILD_LESSON_SECTION_ORDER: readonly ChildLessonRecordSection[] = [
	'current',
	'assignments',
	'attendance',
	'other',
];
export const MAX_SUBSTITUTION_DATES = 31;

const RESOURCE_KINDS: readonly PortalResourceKind[] = [
	'account',
	'messages',
	'timetable',
	'substitutions',
	'substitution-dates',
	'calendar',
	'school-calendar',
	'lessons',
	'learning-groups',
	'file-metadata',
];

interface TableResult {
	group: PortalRecordGroup;
	records: PortalHtmlRecord[];
	confirmedStructure: boolean;
}

/**
 * Parses decoded HTML or JSON for a verified resource family without issuing requests.
 *
 * @param kind The verified page family being parsed.
 * @param body The decoded response text.
 * @param contentType The response content type, when available.
 * @returns A complete record set, an unavailable status, or an invalid-response status.
 */
export function parsePortalResource(kind: PortalResourceKind, body: string, contentType?: string): PortalParseResult {
	return parsePortalResourceInternal(kind, body, contentType, false);
}

/**
 * Parses a timetable child-detail response, recovering only structurally confirmed personal `#own` tables if
 * unrelated malformed markup makes the page-wide HTML validity check fail.
 *
 * @param body The decoded child-detail response text.
 * @param contentType The response content type, when available.
 * @returns A complete personal timetable or a safe unavailable/invalid result.
 */
export function parsePortalTimetableChildDetail(body: string, contentType?: string): PortalParseResult {
	return parsePortalResourceInternal('timetable', body, contentType, true);
}

function parsePortalResourceInternal(
	kind: PortalResourceKind,
	body: string,
	contentType: string | undefined,
	recoverMalformedTimetableDetail: boolean,
): PortalParseResult {
	if (!RESOURCE_KINDS.includes(kind) || typeof body !== 'string') {
		return { status: 'invalid', kind, reason: 'invalid-input' };
	}

	const source = body.replace(/^\uFEFF/u, '');
	if (!source.trim()) {
		return { status: 'invalid', kind, reason: 'empty-response' };
	}
	const format = getFormat(kind, source, contentType);
	if (!format) {
		return { status: 'invalid', kind, reason: 'unsupported-content-type' };
	}
	if (format === 'json') {
		return kind === 'school-calendar'
			? { status: 'invalid', kind, reason: 'unsupported-content-type' }
			: parseJsonRecords(kind, source);
	}
	if (format === 'csv') {
		return kind === 'school-calendar'
			? parseSchoolCalendarCsv(source)
			: { status: 'invalid', kind, reason: 'unsupported-content-type' };
	}
	if (format === 'ical') {
		return kind === 'school-calendar'
			? parseSchoolCalendarIcal(source)
			: { status: 'invalid', kind, reason: 'unsupported-content-type' };
	}
	return parseHtmlRecords(kind, source, recoverMalformedTimetableDetail);
}

function getFormat(
	kind: PortalResourceKind,
	body: string,
	contentType?: string,
): 'html' | 'json' | 'csv' | 'ical' | null {
	const mimeType = contentType?.split(';', 1)[0].trim().toLowerCase();
	if (mimeType?.includes('json')) {
		return 'json';
	}
	if (mimeType?.includes('html') || mimeType?.includes('xhtml')) {
		return 'html';
	}
	if (mimeType?.includes('csv')) {
		return 'csv';
	}
	if (mimeType && /(?:^|\/)(?:calendar|icalendar|x-vcalendar|ics)$/u.test(mimeType)) {
		return 'ical';
	}

	const trimmed = body.trimStart();
	if (/^BEGIN:VCALENDAR(?:\r?\n|$)/iu.test(trimmed)) {
		return 'ical';
	}
	const first = trimmed[0];
	if (first === '{' || first === '[') {
		return 'json';
	}
	if (first === '<') {
		return 'html';
	}
	return kind === 'school-calendar' && (trimmed.includes(',') || trimmed.includes(';')) ? 'csv' : null;
}

function parseJsonRecords(kind: PortalResourceKind, body: string): PortalParseResult {
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return { status: 'invalid', kind, reason: 'malformed-json' };
	}

	if (!Array.isArray(value)) {
		return { status: 'unavailable', kind, reason: 'unrecognized-json-structure' };
	}
	if (value.length === 0) {
		return kind === 'calendar' || kind === 'substitutions' || kind === 'messages'
			? { status: 'complete', kind, records: [], groups: [] }
			: { status: 'unavailable', kind, reason: 'unrecognized-json-structure' };
	}
	if (!value.every(isRecord)) {
		return { status: 'invalid', kind, reason: 'invalid-json-records' };
	}

	const records: PortalJsonRecord[] = value.map(sourceFields => {
		const fields =
			kind === 'messages'
				? sanitizeMessageFields(sourceFields)
				: sanitizeJsonFields(sourceFields, kind === 'file-metadata');
		return {
			format: 'json',
			id: getJsonId(fields),
			fields,
		};
	});
	if (hasDuplicateRecordIds(records)) {
		return { status: 'invalid', kind, reason: 'invalid-json-records' };
	}
	return { status: 'complete', kind, records, groups: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const MESSAGE_METADATA_FIELDS = new Set(['id', 'subject', 'sendershortname', 'sendername', 'date', 'unread', 'hidden']);

function sanitizeMessageFields(fields: Record<string, unknown>): Record<string, unknown> {
	const metadata = Object.fromEntries(
		Object.entries(fields).filter(([name]) => MESSAGE_METADATA_FIELDS.has(normalizeRecordKey(name))),
	);
	const safe = sanitizeJsonFields(metadata);
	if (typeof fields.username === 'string') {
		const username = sanitizeMessageText(fields.username);
		if (username !== null) {
			safe.username = username;
		}
	}
	if (typeof fields.own === 'boolean') {
		safe.own = fields.own;
	}
	if (typeof fields.content === 'string') {
		const content = sanitizeMessageText(fields.content);
		if (content !== null) {
			safe.content = content;
		}
	}
	if (Number.isSafeInteger(fields.time) && (fields.time as number) >= 0) {
		safe.time = fields.time;
	}
	for (const name of ['groupChat', 'onlyPrivateAnswers', 'noReply'] as const) {
		if (typeof fields[name] === 'boolean') {
			safe[name] = fields[name];
		}
	}
	const participantCounts = fields.participantCounts;
	if (isRecord(participantCounts)) {
		const counts = ['students', 'teachers', 'parents'] as const;
		if (
			counts.every(
				name =>
					typeof participantCounts[name] === 'number' &&
					Number.isSafeInteger(participantCounts[name]) &&
					participantCounts[name] >= 0,
			)
		) {
			safe.participantCounts = Object.fromEntries(counts.map(name => [name, participantCounts[name]]));
		}
	}
	if (Array.isArray(fields.replies) && fields.replies.length <= 100) {
		const replies = fields.replies.map(sanitizeMessageReply);
		if (replies.every(reply => reply !== null)) {
			safe.replies = replies;
		}
	}
	return safe;
}

function sanitizeMessageReply(value: unknown): Record<string, unknown> | null {
	if (
		!isRecord(value) ||
		typeof value.id !== 'string' ||
		!/^[a-f0-9]{64}$/u.test(value.id) ||
		typeof value.date !== 'string' ||
		value.date.length > 8192 ||
		hasControlCharacters(value.date) ||
		typeof value.username !== 'string' ||
		typeof value.own !== 'boolean' ||
		typeof value.content !== 'string'
	) {
		return null;
	}
	const username = sanitizeMessageText(value.username);
	const content = sanitizeMessageText(value.content);
	if (username === null || content === null) {
		return null;
	}
	return { id: value.id, date: value.date, username, own: value.own, content };
}

function hasUnsafeMessageTextControls(value: string): boolean {
	return Array.from(value).some(character => {
		const codePoint = character.codePointAt(0);
		return (
			codePoint !== undefined &&
			((codePoint < 0x20 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
				(codePoint >= 0x7f && codePoint <= 0x9f))
		);
	});
}

function sanitizeMessageText(value: string): string | null {
	if (value.length > 4 * 1024 * 1024 || hasUnsafeMessageTextControls(value)) {
		return null;
	}
	try {
		const toText = (html: string): string => {
			const root = parse(html);
			for (const unsafe of root.querySelectorAll('script, style, iframe, object, embed')) {
				unsafe.remove();
			}
			for (const hidden of root.querySelectorAll('[hidden], [aria-hidden="true"], .hidden, .hidden_encoded')) {
				hidden.remove();
			}
			return root.text;
		};
		let text = toText(value);
		if (/<\/?[a-z][^>]*>/iu.test(text)) {
			text = toText(text);
		}
		return text.replace(/\r\n?/gu, '\n').trim();
	} catch {
		return null;
	}
}

const OMIT_JSON_VALUE = Symbol('omit-json-value');

function sanitizeJsonFields(fields: Record<string, unknown>, omitUrls = false): Record<string, unknown> {
	const safe: [string, unknown][] = [];
	for (const [name, value] of Object.entries(fields)) {
		const normalizedName = name.replace(/[A-Z]/gu, letter => `_${letter.toLowerCase()}`).toLowerCase();
		if (
			/(?:session|sess(?:ion)?id|sid|token|cookie|csrf|auth|secret|password|credential|ticket)/iu.test(name) ||
			/(?:html|markup)/iu.test(name) ||
			(normalizedName === 'id' && typeof value === 'string' && !isSafeExplicitId(value))
		) {
			continue;
		}
		const isUrlField = /(?:^|_)(?:href|url|uri|link|src|path)$/u.test(normalizedName);
		if (omitUrls && isUrlField) {
			continue;
		}
		const sanitized = sanitizeJsonValue(value, isUrlField, omitUrls);
		if (sanitized !== OMIT_JSON_VALUE) {
			safe.push([name, sanitized]);
		}
	}
	return Object.fromEntries(safe);
}

function sanitizeJsonValue(value: unknown, isUrlField = false, omitUrls = false): unknown {
	if (typeof value === 'string') {
		if (/<\/?[a-z][^>]*>/iu.test(value)) {
			return OMIT_JSON_VALUE;
		}
		if (isUrlField || looksLikeUrl(value)) {
			return omitUrls ? OMIT_JSON_VALUE : (safeRelativePath(value) ?? OMIT_JSON_VALUE);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(item => sanitizeJsonValue(item, false, omitUrls)).filter(item => item !== OMIT_JSON_VALUE);
	}
	if (isRecord(value)) {
		return sanitizeJsonFields(value, omitUrls);
	}
	return value;
}

function looksLikeUrl(value: string): boolean {
	return (
		value.startsWith('/') ||
		value.startsWith('./') ||
		value.startsWith('../') ||
		/^[a-z][a-z\d+.-]*:/iu.test(value) ||
		(value.startsWith('?') && value.length > 1) ||
		/^[^ ]+\?[^ ]*=/u.test(value)
	);
}

function hasDuplicateRecordIds(records: readonly PortalRecord[]): boolean {
	const seen = new Set<string>();
	for (const record of records) {
		if (seen.has(record.id)) {
			return true;
		}
		seen.add(record.id);
	}
	return false;
}

function getJsonId(fields: Record<string, unknown>): string {
	const idNames = ['uid', 'fremuid', 'fremduid', 'id', 'eventid'];
	for (const idName of idNames) {
		const sourceId = Object.entries(fields).find(([name]) => normalizeRecordKey(name) === idName)?.[1];
		if ((typeof sourceId === 'string' && isSafeExplicitId(sourceId)) || typeof sourceId === 'number') {
			return hashSourceId(String(sourceId));
		}
	}
	return hashId(canonicalJson(fields));
}

function normalizeRecordKey(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/ß/gu, 'ss')
		.toLowerCase()
		.replace(/[^a-z0-9]/gu, '');
}

function hashSourceId(sourceId: string): string {
	return `source:${createHash('sha256').update(sourceId).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
	if (typeof value === 'string') {
		return JSON.stringify(normalizeText(value));
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

type SchoolCalendarField =
	'start' | 'end' | 'all_day' | 'summary' | 'description' | 'location' | 'category' | 'responsible' | 'uid';

const SCHOOL_CALENDAR_HEADER_ALIASES: Readonly<Record<SchoolCalendarField, readonly string[]>> = {
	start: ['start', 'begin', 'beginning', 'startdate', 'startdatetime', 'anfang', 'from'],
	end: ['end', 'until', 'enddate', 'enddatetime', 'ende', 'to'],
	all_day: ['allday', 'isallday', 'fullday', 'ganztag', 'ganztags', 'ganztaegig', 'ganztagig'],
	summary: ['summary', 'title', 'titel', 'subject', 'betreff', 'name'],
	description: ['description', 'beschreibung', 'details', 'detail'],
	location: ['location', 'place', 'ort', 'room', 'raum'],
	category: ['category', 'categories', 'art', 'kategorie', 'type', 'typ'],
	responsible: ['responsible', 'organizer', 'organiser', 'verantwortlich', 'owner'],
	uid: ['uid', 'id', 'eventid', 'eventuid', 'fremuid'],
};

function parseSchoolCalendarCsv(body: string): PortalParseResult {
	const candidates = [parseCsvRows(body, ','), parseCsvRows(body, ';')].filter(
		(rows): rows is string[][] => rows !== null && rows.length > 0,
	);
	const rows = candidates.sort((left, right) => calendarHeaderScore(right[0]) - calendarHeaderScore(left[0]))[0];
	if (!rows) {
		return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-csv' };
	}

	const headers = rows[0].map(calendarFieldForHeader);
	const recognizedHeaders = headers.filter((header): header is SchoolCalendarField => header !== null);
	if (
		!headers.includes('start') ||
		!headers.includes('end') ||
		new Set(recognizedHeaders).size !== recognizedHeaders.length
	) {
		return { status: 'invalid', kind: 'school-calendar', reason: 'unexpected-calendar-structure' };
	}

	const records: PortalJsonRecord[] = [];
	for (const row of rows.slice(1)) {
		if (row.length !== headers.length) {
			return { status: 'invalid', kind: 'school-calendar', reason: 'invalid-csv-records' };
		}
		const sourceFields: Record<string, unknown> = {};
		for (const [index, header] of headers.entries()) {
			if (!header) {
				continue;
			}
			const value = row[index];
			sourceFields[header] = header === 'all_day' ? parseAllDayValue(value) : value;
		}
		const fields = sanitizeJsonFields(sourceFields);
		records.push({ format: 'json', id: getJsonId(fields), fields });
	}
	if (hasDuplicateRecordIds(records)) {
		return { status: 'invalid', kind: 'school-calendar', reason: 'invalid-csv-records' };
	}
	return { status: 'complete', kind: 'school-calendar', records, groups: [] };
}

function parseCsvRows(body: string, delimiter: ',' | ';'): string[][] | null {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	let afterQuote = false;
	const finishField = (): void => {
		row.push(field);
		field = '';
		afterQuote = false;
	};
	const finishRow = (): void => {
		finishField();
		if (row.length > 1 || row.some(value => value.length > 0)) {
			rows.push(row);
		}
		row = [];
	};

	for (let index = 0; index < body.length; index++) {
		const character = body[index];
		if (inQuotes) {
			if (character === '"') {
				if (body[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					inQuotes = false;
					afterQuote = true;
				}
			} else {
				field += character;
			}
			continue;
		}

		if (
			afterQuote &&
			character !== delimiter &&
			character !== '\r' &&
			character !== '\n' &&
			!/[ \t]/u.test(character)
		) {
			return null;
		}
		if (character === delimiter) {
			finishField();
		} else if (character === '\r' || character === '\n') {
			finishRow();
			if (character === '\r' && body[index + 1] === '\n') {
				index++;
			}
		} else if (character === '"') {
			if (field.length > 0 || afterQuote) {
				return null;
			}
			inQuotes = true;
		} else if (!afterQuote) {
			field += character;
		}
	}

	if (inQuotes) {
		return null;
	}
	if (field.length > 0 || row.length > 0 || afterQuote) {
		finishRow();
	}
	return rows;
}

function calendarHeaderScore(headers: readonly string[]): number {
	return headers.filter(header => calendarFieldForHeader(header) !== null).length;
}

function calendarFieldForHeader(header: string): SchoolCalendarField | null {
	const normalized = normalizeRecordKey(header.trim());
	return (
		(Object.entries(SCHOOL_CALENDAR_HEADER_ALIASES) as [SchoolCalendarField, readonly string[]][]).find(
			([, aliases]) => aliases.includes(normalized),
		)?.[0] ?? null
	);
}

function parseAllDayValue(value: string): boolean | string {
	const normalized = normalizeRecordKey(value.trim());
	if (['1', 'true', 'yes', 'ja', 'y', 'ganztag', 'ganztags'].includes(normalized)) {
		return true;
	}
	if (['0', 'false', 'no', 'nein', 'n'].includes(normalized)) {
		return false;
	}
	return value;
}

interface IcalProperty {
	name: string;
	params: Readonly<Record<string, string>>;
	value: string;
}

function parseSchoolCalendarIcal(body: string): PortalParseResult {
	const lines = unfoldIcalLines(body);
	if (!lines || lines.length === 0) {
		return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
	}

	const components: string[] = [];
	const records: PortalJsonRecord[] = [];
	let calendarStarted = false;
	let calendarEnded = false;
	let eventProperties: IcalProperty[] | null = null;

	for (const line of lines) {
		if (!line) {
			return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
		}
		const property = parseIcalProperty(line);
		if (!property) {
			return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
		}
		if (property.name === 'BEGIN') {
			const component = property.value.toUpperCase();
			if (!/^[A-Z0-9-]+$/u.test(component) || calendarEnded) {
				return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
			}
			if (components.length === 0) {
				if (calendarStarted || component !== 'VCALENDAR') {
					return { status: 'invalid', kind: 'school-calendar', reason: 'unexpected-calendar-structure' };
				}
				calendarStarted = true;
			} else if (components[0] !== 'VCALENDAR' || component === 'VCALENDAR') {
				return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
			}
			if (component === 'VEVENT' && (components.length !== 1 || components[0] !== 'VCALENDAR')) {
				return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
			}
			components.push(component);
			if (component === 'VEVENT') {
				eventProperties = [];
			}
			continue;
		}
		if (property.name === 'END') {
			const component = property.value.toUpperCase();
			if (components.at(-1) !== component) {
				return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
			}
			if (component === 'VEVENT') {
				const record = createIcalEventRecord(eventProperties ?? []);
				if (!record) {
					return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
				}
				records.push(record);
				eventProperties = null;
			}
			components.pop();
			if (component === 'VCALENDAR') {
				calendarEnded = true;
			}
			continue;
		}
		if (components.length === 0 || calendarEnded) {
			return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
		}
		if (components.at(-1) === 'VEVENT' && components.length === 2) {
			eventProperties?.push(property);
		}
	}

	if (!calendarStarted || !calendarEnded || components.length > 0) {
		return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
	}
	if (hasDuplicateRecordIds(records)) {
		return { status: 'invalid', kind: 'school-calendar', reason: 'malformed-icalendar' };
	}
	return { status: 'complete', kind: 'school-calendar', records, groups: [] };
}

function unfoldIcalLines(body: string): string[] | null {
	const physicalLines = body.split(/\r\n|\n|\r/u);
	while (physicalLines.at(-1) === '') {
		physicalLines.pop();
	}
	const lines: string[] = [];
	for (const line of physicalLines) {
		if (line.startsWith(' ') || line.startsWith('\t')) {
			if (lines.length === 0) {
				return null;
			}
			lines[lines.length - 1] += line.slice(1);
		} else {
			lines.push(line);
		}
	}
	return lines;
}

function parseIcalProperty(line: string): IcalProperty | null {
	const separator = findIcalValueSeparator(line);
	if (separator <= 0) {
		return null;
	}
	const headerParts = splitIcalHeader(line.slice(0, separator));
	if (!headerParts || headerParts.length === 0) {
		return null;
	}
	const rawName = headerParts[0].split('.').at(-1) ?? '';
	if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(rawName)) {
		return null;
	}
	const params: [string, string][] = [];
	for (const parameter of headerParts.slice(1)) {
		const equals = parameter.indexOf('=');
		if (equals <= 0) {
			return null;
		}
		const name = parameter.slice(0, equals).trim().toUpperCase();
		let value = parameter.slice(equals + 1).trim();
		if (!/^[A-Z0-9-]+$/u.test(name)) {
			return null;
		}
		if (value.startsWith('"')) {
			if (!value.endsWith('"') || value.length < 2) {
				return null;
			}
			value = value.slice(1, -1).replace(/\^n/giu, '\n').replace(/\^'/gu, '"').replace(/\^\^/gu, '^');
		}
		params.push([name, value]);
	}
	return {
		name: rawName.toUpperCase(),
		params: Object.fromEntries(params),
		value: unescapeIcalText(line.slice(separator + 1)),
	};
}

function findIcalValueSeparator(line: string): number {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < line.length; index++) {
		const character = line[index];
		if (escaped) {
			escaped = false;
		} else if (character === '\\' && quoted) {
			escaped = true;
		} else if (character === '"') {
			quoted = !quoted;
		} else if (character === ':' && !quoted) {
			return index;
		}
	}
	return -1;
}

function splitIcalHeader(header: string): string[] | null {
	const parts: string[] = [];
	let start = 0;
	let quoted = false;
	for (let index = 0; index < header.length; index++) {
		if (header[index] === '"') {
			quoted = !quoted;
		} else if (header[index] === ';' && !quoted) {
			parts.push(header.slice(start, index));
			start = index + 1;
		}
	}
	if (quoted) {
		return null;
	}
	parts.push(header.slice(start));
	return parts;
}

function unescapeIcalText(value: string): string {
	let result = '';
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (character === '\\' && index + 1 < value.length) {
			const escaped = value[++index];
			if (escaped === 'n' || escaped === 'N') {
				result += '\n';
			} else if (escaped === '\\' || escaped === ',' || escaped === ';') {
				result += escaped;
			} else {
				result += `\\${escaped}`;
			}
		} else {
			result += character;
		}
	}
	return result;
}

function createIcalEventRecord(properties: readonly IcalProperty[]): PortalJsonRecord | null {
	const start = properties.find(property => property.name === 'DTSTART');
	if (!start?.value) {
		return null;
	}
	const startType = getIcalDateType(start);
	if (!startType) {
		return null;
	}
	const end = properties.find(property => property.name === 'DTEND');
	const endType = end ? getIcalDateType(end) : undefined;
	if (end && (!endType || endType !== startType)) {
		return null;
	}
	const fields: Record<string, unknown> = {
		start: start.value,
		start_type: startType,
		all_day: startType === 'DATE',
	};
	if (start.params.TZID) {
		fields.start_tzid = start.params.TZID;
	}
	if (end) {
		fields.end = end.value;
		fields.end_type = endType;
		if (end.params.TZID) {
			fields.end_tzid = end.params.TZID;
		}
	}
	const setFirstProperty = (name: string, field: SchoolCalendarField): void => {
		const value = properties.find(property => property.name === name)?.value;
		if (value !== undefined) {
			fields[field] = value;
		}
	};
	setFirstProperty('SUMMARY', 'summary');
	setFirstProperty('DESCRIPTION', 'description');
	setFirstProperty('LOCATION', 'location');
	setFirstProperty('UID', 'uid');
	const categories = properties
		.filter(property => property.name === 'CATEGORIES' || property.name === 'CATEGORY')
		.map(property => property.value)
		.filter(value => value.length > 0);
	if (categories.length > 0) {
		fields.category = categories.join(', ');
	}
	const organizer = properties.find(property => property.name === 'ORGANIZER');
	if (organizer) {
		fields.responsible = organizer.params.CN ?? organizer.value;
	}
	const safeFields = sanitizeJsonFields(fields);
	return { format: 'json', id: getJsonId(safeFields), fields: safeFields };
}

function getIcalDateType(property: IcalProperty): 'DATE' | 'DATE-TIME' | null {
	const type = property.params.VALUE?.toUpperCase();
	if (type === 'DATE' || (!type && /^\d{8}$/u.test(property.value))) {
		return /^\d{8}$/u.test(property.value) ? 'DATE' : null;
	}
	if (type && type !== 'DATE-TIME') {
		return null;
	}
	return /^\d{8}T\d{6}Z?$/u.test(property.value) ? 'DATE-TIME' : null;
}

function parseHtmlRecords(
	kind: PortalResourceKind,
	body: string,
	recoverMalformedTimetableDetail = false,
): PortalParseResult {
	let root: HTMLElement;
	try {
		root = parse(body);
	} catch {
		return { status: 'invalid', kind, reason: 'malformed-html' };
	}

	if (hasLoginRequiredContent(root)) {
		return { status: 'unavailable', kind, reason: 'login-required' };
	}
	const visibleText = root.text.toLocaleLowerCase('de-DE').normalize('NFKC');
	if (hasPermissionDenial(visibleText)) {
		return { status: 'unavailable', kind, reason: 'permission-denied' };
	}
	if (hasFeatureUnavailable(visibleText)) {
		return { status: 'unavailable', kind, reason: 'feature-unavailable' };
	}
	const isValidHtml = valid(body);
	const canRecoverMalformedTimetableDetail = kind === 'timetable' && recoverMalformedTimetableDetail;
	if (!isValidHtml && !canRecoverMalformedTimetableDetail) {
		return { status: 'invalid', kind, reason: 'malformed-html' };
	}

	if (kind === 'substitutions') {
		return parseOwnSubstitutionTables(root);
	}
	if (kind === 'substitution-dates') {
		return parseSubstitutionDates(root);
	}
	if (kind === 'account') {
		return parseAccountHtml(root);
	}
	if (kind === 'lessons') {
		const parentLessons = parseParentLessonTabs(root);
		if (parentLessons) {
			return parentLessons;
		}
	}
	if (kind === 'timetable') {
		const parentTimetable = parseParentTimetableIndex(root);
		if (parentTimetable) {
			return parentTimetable;
		}
	}

	const spec = htmlSpec(kind);
	if (!spec) {
		return { status: 'unavailable', kind, reason: 'unsupported-html-structure' };
	}

	const folderRecords = kind === 'file-metadata' ? parseFileFolderRecords(root) : [];
	if (folderRecords === null) {
		return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
	}
	const pageTables = spec.getTables(root);
	const tables =
		!isValidHtml && canRecoverMalformedTimetableDetail
			? pageTables.filter(({ section }) => section === 'own')
			: pageTables;
	if (!isValidHtml && tables.length === 0) {
		return { status: 'invalid', kind, reason: 'malformed-html' };
	}
	if (!tables.length) {
		if (kind === 'file-metadata' && folderRecords.length > 0) {
			return { status: 'complete', kind, records: folderRecords, groups: [] };
		}
		const elements = allElements(root);
		const htmlTables = elements.filter(element => element.tagName === 'TABLE');
		const hasTable = htmlTables.length > 0;
		if (kind === 'timetable') {
			const hasTimetableSection = elements.some(element =>
				TIMETABLE_SECTION_IDS.some(sectionId => sectionId === element.getAttribute('id')),
			);
			if (!hasTimetableSection && hasTable && htmlTables.every(table => table.closest('.footer') !== null)) {
				return { status: 'unavailable', kind, reason: 'feature-unavailable' };
			}
			return {
				status: 'invalid',
				kind,
				reason: hasTimetableSection
					? 'timetable-tables-missing'
					: hasTable
						? 'timetable-sections-missing-with-tables'
						: 'timetable-sections-missing-no-tables',
			};
		}
		if (kind === 'lessons') {
			const hasLessonSection = elements.some(element =>
				LESSON_SECTION_IDS.some(sectionId => sectionId === element.getAttribute('id')),
			);
			return {
				status: 'invalid',
				kind,
				reason: hasLessonSection
					? 'lessons-tables-missing'
					: hasTable
						? 'lessons-sections-missing-with-tables'
						: 'lessons-sections-missing-no-tables',
			};
		}
		return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
	}

	const groups: PortalRecordGroup[] = [];
	const records: PortalRecord[] = [...folderRecords];
	for (const { section, table, printableRowsOnly } of tables) {
		const result = parseTable(
			table,
			section,
			printableRowsOnly ?? false,
			kind === 'lessons' && section === 'mappen',
			kind === 'file-metadata',
		);
		if (!result.confirmedStructure) {
			return {
				status: 'invalid',
				kind,
				reason:
					!isValidHtml && canRecoverMalformedTimetableDetail
						? 'malformed-html'
						: kind === 'lessons'
							? 'lessons-table-structure-invalid'
							: 'unexpected-html-structure',
			};
		}
		if (kind === 'file-metadata') {
			const fileHeaders = result.group.headers[0]?.map(cell => fileFieldForHeader(cell.text)) ?? [];
			if (!(['name', 'modified', 'size'] as const).every(header => fileHeaders.includes(header))) {
				return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
			}
			const fileRecords = toFileJsonRecords(result.records);
			groups.push({ ...result.group, recordIds: fileRecords.map(record => record.id) });
			records.push(...fileRecords);
		} else {
			groups.push(result.group);
			const tableRecords =
				kind === 'timetable'
					? result.records.map(record => ({
							...record,
							fields: record.fields.map(field => ({ ...field, text: normalizeText(field.text) })),
						}))
					: result.records;
			records.push(...tableRecords);
		}
	}
	if (hasDuplicateRecordIds(records)) {
		return {
			status: 'invalid',
			kind,
			reason: kind === 'lessons' ? 'duplicate-record-ids' : 'unexpected-html-structure',
		};
	}
	return { status: 'complete', kind, records, groups };
}

function isLearnersTabPanel(root: HTMLElement, panel: HTMLElement): boolean {
	const panelId = panel.getAttribute('id');
	const labelledBy = (panel.getAttribute('aria-labelledby') ?? '').split(/\s+/u).filter(Boolean);
	const labels = allElements(root).filter(element => {
		const elementId = element.getAttribute('id');
		return (
			(typeof elementId === 'string' && labelledBy.includes(elementId)) ||
			(typeof panelId === 'string' &&
				(element.getAttribute('aria-controls') === panelId || element.getAttribute('href') === `#${panelId}`))
		);
	});
	const labelText = [panel.getAttribute('aria-label') ?? '', ...labels.map(label => label.text)]
		.join(' ')
		.replace(/\s+/gu, ' ')
		.toLocaleLowerCase();
	return /\blernende\b/u.test(labelText);
}

function parseParentTimetableIndex(root: HTMLElement): PortalParseResult | null {
	const learnerPanels = new Set(
		allElements(root).filter(
			element => element.getAttribute('role') === 'tabpanel' && isLearnersTabPanel(root, element),
		),
	);
	const links = root.querySelectorAll('a[href]').filter(anchor => {
		const panel = anchor.closest('[role="tabpanel"]');
		if (!panel || !learnerPanels.has(panel) || !anchor.parentNode?.classList.contains('list-group')) {
			return false;
		}
		return /(?:[?&])a=detail_klasse(?:&|$)/u.test(anchor.getAttribute('href') ?? '');
	});
	if (links.length === 0) {
		return null;
	}
	const invalid: PortalParseResult = {
		status: 'invalid',
		kind: 'timetable',
		reason: 'timetable-child-links-invalid',
	};
	if (links.length > MAX_PARENT_CHILD_TABS) {
		return invalid;
	}

	const ids = new Set<string>();
	const children: PortalTimetableChildLink[] = [];
	for (const anchor of links) {
		const href = anchor.getAttribute('href') ?? '';
		let url: URL;
		try {
			url = new URL(href, 'https://start.schulportal.hessen.de');
		} catch {
			return invalid;
		}
		const queryKeys = [...url.searchParams.keys()].sort();
		const classId = url.searchParams.get('k') ?? '';
		const studentId = url.searchParams.get('p') ?? '';
		if (
			url.origin !== 'https://start.schulportal.hessen.de' ||
			url.pathname !== '/stundenplan.php' ||
			url.hash ||
			JSON.stringify(queryKeys) !== JSON.stringify(['a', 'e', 'k', 'p']) ||
			url.searchParams.get('e') !== '1' ||
			url.searchParams.get('a') !== 'detail_klasse' ||
			!/^[A-Za-z0-9_-]{1,32}$/u.test(classId) ||
			!/^[0-9]{1,20}$/u.test(studentId)
		) {
			return invalid;
		}
		const id = createHash('sha256').update(`p${studentId}`).digest('hex');
		if (ids.has(id)) {
			return invalid;
		}
		ids.add(id);
		children.push({
			id,
			requestPath: `/stundenplan.php?e=1&a=detail_klasse&k=${encodeURIComponent(classId)}&p=${studentId}`,
		});
	}
	return { status: 'complete', kind: 'timetable', records: [], groups: [], timetableChildren: children };
}

function parseParentLessonTabs(root: HTMLElement): PortalParseResult | null {
	const anchors = root
		.querySelectorAll('a[href]')
		.filter(
			anchor =>
				anchor.getAttribute('data-toggle') === 'tab' && (anchor.getAttribute('href') ?? '').startsWith('#p'),
		);
	if (anchors.length === 0) {
		return null;
	}

	const invalid: PortalParseResult = { status: 'invalid', kind: 'lessons', reason: 'lessons-tabs-invalid' };
	if (anchors.length > MAX_PARENT_CHILD_TABS) {
		return invalid;
	}
	const childIds = new Set<string>();
	const children: PortalChildLessons[] = [];
	const groups: PortalRecordGroup[] = [];
	const records: PortalRecord[] = [];

	for (const anchor of anchors) {
		const href = anchor.getAttribute('href') ?? '';
		if (!/^#p\d+$/u.test(href)) {
			return invalid;
		}
		const name = anchor.text.replace(/\s+/gu, ' ').trim();
		if (!name || name.length > 256 || hasControlCharacters(name)) {
			return invalid;
		}
		const matchingPanels = allElements(root).filter(element => element.getAttribute('id') === href.slice(1));
		if (
			matchingPanels.length !== 1 ||
			matchingPanels[0]?.tagName !== 'DIV' ||
			!matchingPanels[0].classList.contains('tab-pane')
		) {
			return invalid;
		}
		const childId = createHash('sha256').update(href.slice(1)).digest('hex');
		if (childIds.has(childId)) {
			return invalid;
		}
		childIds.add(childId);

		const panel = matchingPanels[0];
		if (!panel) {
			return invalid;
		}
		const nestedPanes = getNestedChildLessonPanes(panel, href.slice(1));
		if (!nestedPanes) {
			return invalid;
		}
		const childRecords: PortalRecord[] = [];
		const verifiedSections = new Set<ChildLessonRecordSection>();
		const tables: {
			table: HTMLElement;
			tableIndex: number;
			childSection?: ChildLessonRecordSection;
			paneId?: string;
		}[] = [];
		const directTables = tablesWithin(panel).filter(
			table => !isNestedTable(table, panel) && table.closest('.tab-pane') === panel,
		);
		for (const [tableIndex, table] of directTables.entries()) {
			tables.push({ table, tableIndex });
		}
		for (const pane of nestedPanes) {
			const paneTables = tablesWithin(pane.element).filter(
				table => !isNestedTable(table, pane.element) && table.closest('.tab-pane') === pane.element,
			);
			for (const [tableIndex, table] of paneTables.entries()) {
				tables.push({ table, tableIndex, childSection: pane.section, paneId: pane.id });
			}
		}
		if (tables.length === 0) {
			return invalid;
		}
		for (const { table, tableIndex, childSection, paneId } of tables) {
			const result = parseTable(table, 'child-lessons', false, true, false);
			if (!result.confirmedStructure) {
				return invalid;
			}
			verifiedSections.add(childSection ?? 'other');
			const idCounts = new Map<string, number>();
			for (const record of result.records) {
				idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
			}
			const tableRecordIds = new Set<string>();
			const tableRecords: PortalRecord[] = [];
			for (const record of result.records) {
				let sourceId = record.id;
				if ((idCounts.get(record.id) ?? 0) > 1) {
					if (record.format !== 'html') {
						return invalid;
					}
					sourceId = hashId({
						attributes: record.attributes,
						fields: record.fields,
						courseId: record.courseId ?? null,
						markers: record.markers ?? [],
					});
				}
				if (tableRecordIds.has(sourceId)) {
					return invalid;
				}
				tableRecordIds.add(sourceId);
				const tableScope = paneId
					? `lesson-child:${childId}:pane:${hashSourceId(paneId)}:table:${tableIndex}:${sourceId}`
					: `lesson-child:${childId}:table:${tableIndex}:${sourceId}`;
				const id = hashSourceId(tableScope);
				tableRecords.push({
					...record,
					id,
					section: 'child-lessons',
					...(childSection ? { childSection } : {}),
					context: { childId },
				});
			}
			childRecords.push(...tableRecords);
			groups.push({
				...result.group,
				section: 'child-lessons',
				recordIds: tableRecords.map(record => record.id),
			});
		}
		children.push({
			id: childId,
			name,
			records: childRecords,
			...(verifiedSections.size > 0
				? { sections: CHILD_LESSON_SECTION_ORDER.filter(section => verifiedSections.has(section)) }
				: {}),
		});
		records.push(...childRecords);
	}

	if (hasDuplicateRecordIds(records)) {
		return invalid;
	}
	return { status: 'complete', kind: 'lessons', records, groups, children };
}

interface NestedChildLessonPane {
	id: string;
	element: HTMLElement;
	section: ChildLessonRecordSection;
}

function getNestedChildLessonPanes(panel: HTMLElement, parentId: string): NestedChildLessonPane[] | null {
	const anchors = panel
		.querySelectorAll('a[href]')
		.filter(anchor => anchor.getAttribute('data-toggle') === 'tab' && anchor.closest('.tab-pane') === panel);
	const paneIds = new Set<string>();
	const panes: NestedChildLessonPane[] = [];
	for (const anchor of anchors) {
		const match = /^#([A-Za-z][A-Za-z0-9_-]*)$/u.exec(anchor.getAttribute('href') ?? '');
		if (!match?.[1] || match[1] === parentId) {
			continue;
		}
		const id = match[1];
		const section = getChildLessonSection(id, parentId.slice(1));
		const matchingPanes = allElements(panel).filter(element => element.getAttribute('id') === id);
		const pane = matchingPanes.length === 1 ? matchingPanes[0] : undefined;
		let owner = pane?.parentNode;
		while (owner && owner !== panel && !owner.classList.contains('tab-pane')) {
			owner = owner.parentNode;
		}
		if (!pane || pane.tagName !== 'DIV' || !pane.classList.contains('tab-pane') || owner !== panel) {
			if (section !== 'other') {
				return null;
			}
			continue;
		}
		if (paneIds.has(id)) {
			return null;
		}
		paneIds.add(id);
		panes.push({ id, element: pane, section });
	}
	return panes;
}

function getChildLessonSection(paneId: string, parentNumericId: string): ChildLessonRecordSection {
	if (paneId === `aktuell${parentNumericId}`) {
		return 'current';
	}
	if (paneId === `mappen${parentNumericId}`) {
		return 'assignments';
	}
	if (paneId === `anwesend${parentNumericId}`) {
		return 'attendance';
	}
	return 'other';
}

function parseAccountHtml(root: HTMLElement): PortalParseResult {
	const tableBodies = root.querySelectorAll('div.col-md-12 table.table.table-striped tbody');
	const records: PortalJsonRecord[] = [];
	for (const body of tableBodies) {
		for (const row of body.querySelectorAll('tr')) {
			const cells = row.querySelectorAll(':scope > td, :scope > th');
			if (cells.length < 2) {
				return { status: 'invalid', kind: 'account', reason: 'unexpected-html-structure' };
			}
			const label = cells[0].text.trim();
			if (!label) {
				return { status: 'invalid', kind: 'account', reason: 'unexpected-html-structure' };
			}
			if (
				/(?:\b(?:password|passwort|kennwort|credential|session|sitzung|token|cookie|authentication|auth|secret|geheim)\b|zugangsdaten)/iu.test(
					label,
				)
			) {
				continue;
			}
			const fields = sanitizeJsonFields({ recordType: 'profile', label, value: cells[1].text });
			records.push({ format: 'json', id: getJsonId(fields), fields });
		}
	}

	const accountTypes = new Set<string>();
	for (const icon of root.querySelectorAll('.nav.navbar-nav.navbar-right > li > a > i')) {
		if (icon.classList.contains('fa-child')) {
			accountTypes.add('student');
		} else if (icon.classList.contains('fa-user-circle')) {
			accountTypes.add('parent');
		} else if (icon.classList.contains('fa-user')) {
			accountTypes.add('teacher');
		}
	}
	if (accountTypes.size > 1) {
		return { status: 'invalid', kind: 'account', reason: 'unexpected-html-structure' };
	}
	const accountType = [...accountTypes][0];
	if (accountType) {
		const fields = { recordType: 'account-type', type: accountType };
		records.push({ format: 'json', id: hashSourceId('account-type'), fields });
	}
	if (tableBodies.length === 0 && !accountType) {
		return { status: 'unavailable', kind: 'account', reason: 'unsupported-html-structure' };
	}
	if (hasDuplicateRecordIds(records)) {
		return { status: 'invalid', kind: 'account', reason: 'unexpected-html-structure' };
	}
	return { status: 'complete', kind: 'account', records, groups: [] };
}

function parseOwnSubstitutionTables(root: HTMLElement): PortalParseResult {
	const kind = 'substitutions';
	if (root.querySelectorAll('.btn-ganzerplan').length > 0) {
		return { status: 'unavailable', kind, reason: 'substitution-whole-plan-button-present' };
	}

	const rawDates = allElements(root)
		.map(element => element.getAttribute('data-tag'))
		.filter((value): value is string => value !== undefined);
	if (rawDates.length === 0) {
		return { status: 'unavailable', kind, reason: 'substitution-date-tags-missing' };
	}
	if (rawDates.length > MAX_SUBSTITUTION_DATES) {
		return { status: 'unavailable', kind, reason: 'substitution-date-count-exceeded' };
	}
	const dates = rawDates.map(normalizeSubstitutionDate);
	if (dates.some(date => date === null) || new Set(dates).size !== dates.length) {
		return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
	}
	const expectedDates = new Set(dates.filter((date): date is string => date !== null));
	const tables = allElements(root).filter(
		element => element.tagName === 'TABLE' && (element.getAttribute('id') ?? '').startsWith('vtable'),
	);
	if (tables.length === 0) {
		return { status: 'unavailable', kind, reason: 'substitution-vtable-tables-missing' };
	}
	if (tables.length !== expectedDates.size) {
		return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
	}

	const tablesByDate = new Map<string, HTMLElement>();
	for (const table of tables) {
		const tableId = table.getAttribute('id') ?? '';
		const date = normalizeSubstitutionDate(tableId.slice('vtable'.length));
		if (!date || !expectedDates.has(date) || tablesByDate.has(date)) {
			return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
		}
		tablesByDate.set(date, table);
	}
	if (tablesByDate.size !== expectedDates.size) {
		return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
	}

	const records: PortalJsonRecord[] = [];
	for (const date of expectedDates) {
		const table = tablesByDate.get(date);
		if (!table) {
			return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
		}
		const parsed = parseTable(table, date, false, false, true);
		const headers = parsed.group.headers[0]?.map(cell => normalizeText(cell.text));
		const tableRows = table.querySelectorAll('tr').filter(row => row.closest('table') === table);
		const emptyMessageRows = tableRows.filter(isExplicitNoSubstitutionRow);
		const isEmptySubstitutionDay =
			emptyMessageRows.length === 1 && parsed.records.length === 1 && parsed.records[0]?.fields.length === 1;
		if (
			!parsed.confirmedStructure ||
			parsed.group.headers.length !== 1 ||
			!headers ||
			headers.length !== SUBSTITUTION_HEADERS.length ||
			headers.some((header, index) => header !== SUBSTITUTION_HEADERS[index]) ||
			tableRows.length !== parsed.group.headers.length + parsed.records.length ||
			parsed.records.some(row => row.fields.length !== SUBSTITUTION_HEADERS.length && !isEmptySubstitutionDay)
		) {
			return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
		}

		if (isEmptySubstitutionDay) {
			continue;
		}

		const duplicateCounts = new Map<string, number>();
		for (const row of parsed.records) {
			const columns = row.fields.map((field, columnIndex) => ({
				header: SUBSTITUTION_HEADERS[columnIndex] ?? '',
				value: normalizeText(field.text),
			}));
			const fields = sanitizeJsonFields({ portalDate: date, columns });
			const identity = hashId({ portalDate: date, fields });
			const occurrence = duplicateCounts.get(identity) ?? 0;
			duplicateCounts.set(identity, occurrence + 1);
			const safeColumns = fields.columns;
			if (
				!Array.isArray(safeColumns) ||
				safeColumns.length !== SUBSTITUTION_HEADERS.length ||
				safeColumns.some(
					(column, columnIndex) =>
						!isRecord(column) ||
						column.header !== SUBSTITUTION_HEADERS[columnIndex] ||
						typeof column.value !== 'string',
				)
			) {
				return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
			}
			records.push({
				format: 'json',
				id: hashId({ portalDate: date, fields, occurrence }),
				fields,
			});
		}
	}
	if (hasDuplicateRecordIds(records)) {
		return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
	}
	return { status: 'complete', kind, records, groups: [] };
}

function isExplicitNoSubstitutionRow(row: HTMLElement): boolean {
	const cells = row.querySelectorAll(':scope > th, :scope > td');
	const cell = cells[0];
	if (
		cells.length !== 1 ||
		!cell ||
		cell.tagName !== 'TD' ||
		cell.getAttribute('colspan') !== String(SUBSTITUTION_HEADERS.length)
	) {
		return false;
	}

	const text = normalizeText(getVisibleCellText(cell))
		.toLocaleLowerCase('de')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/gu, '');
	return /\bkeine\b[^.!?]{0,80}\beintrag\w*\b/u.test(text) && /\bvertret\w*/u.test(text);
}

function parseSubstitutionDates(root: HTMLElement): PortalParseResult {
	const kind = 'substitution-dates';
	const rawDates = allElements(root)
		.map(element => element.getAttribute('data-tag'))
		.filter((value): value is string => value !== undefined);
	if (rawDates.length === 0) {
		return { status: 'unavailable', kind, reason: 'unsupported-html-structure' };
	}
	const dates = rawDates.map(normalizeSubstitutionDate);
	if (dates.some(date => date === null)) {
		return { status: 'invalid', kind, reason: 'unexpected-html-structure' };
	}

	const uniqueDates = new Map<string, string>();
	for (const [index, date] of dates.entries()) {
		const portalTag = rawDates[index];
		if (date && portalTag && !uniqueDates.has(date)) {
			uniqueDates.set(date, portalTag);
		}
	}
	const records: PortalJsonRecord[] = [...uniqueDates].map(([date, portalTag]) => ({
		format: 'json',
		id: hashSourceId(date),
		fields: { date, portalTag },
	}));
	return { status: 'complete', kind, records, groups: [] };
}

function toFileJsonRecords(rows: readonly PortalHtmlRecord[]): PortalJsonRecord[] {
	return rows.map(row => {
		const fileId = row.attributes['data-id'];
		const fields: Record<string, unknown> = { recordType: 'file' };
		if (fileId && /^\d+$/u.test(fileId)) {
			fields.fileId = fileId;
		}
		for (const cell of row.fields) {
			const field = fileFieldForHeader(cell.header ?? '');
			if (field && cell.text) {
				fields[field] = cell.text;
			}
		}
		const columns = row.fields.flatMap(cell =>
			cell.header === null ? [] : [{ header: cell.header, value: cell.text }],
		);
		if (columns.length > 0) {
			fields.columns = columns;
		}
		const attributes = sanitizeAttributes(row.attributes, true);
		if (Object.keys(attributes).length > 0) {
			fields.attributes = attributes;
		}
		const safeFields = sanitizeJsonFields(fields, true);
		return {
			format: 'json',
			id: fileId && /^\d+$/u.test(fileId) ? hashSourceId(`file:${fileId}`) : hashId(safeFields),
			fields: safeFields,
		};
	});
}

function fileFieldForHeader(header: string): 'name' | 'modified' | 'size' | 'note' | null {
	const normalized = normalizeRecordKey(header);
	if (['name', 'filename', 'dateiname'].includes(normalized)) {
		return 'name';
	}
	if (['aenderung', 'anderung', 'geandert', 'modified', 'lastmodified'].includes(normalized)) {
		return 'modified';
	}
	if (['groesse', 'grosse', 'size', 'filesize'].includes(normalized)) {
		return 'size';
	}
	if (['note', 'hinweis', 'bemerkung', 'beschreibung', 'description'].includes(normalized)) {
		return 'note';
	}
	return null;
}

function parseFileFolderRecords(root: HTMLElement): PortalJsonRecord[] | null {
	const folders = allElements(root).filter(element => element.classList.contains('folder'));
	const records: PortalJsonRecord[] = [];
	const seenIds = new Set<string>();
	for (const folder of folders) {
		const folderId = folder.getAttribute('data-id');
		const caption = findFolderChild(folder, '.caption');
		const description = findFolderChild(folder, '.desc');
		if (!folderId || !/^\d+$/u.test(folderId) || !caption || !description || seenIds.has(folderId)) {
			return null;
		}
		seenIds.add(folderId);
		const fields: Record<string, unknown> = {
			recordType: 'folder',
			folderId,
			name: caption.text,
			description: description.text,
		};
		const count = findFolderChild(folder, '[title="Anzahl Ordner"]');
		if (count) {
			const countText = count.text.trim();
			if (countText) {
				const subfolderCount = parseSubfolderCount(countText);
				if (subfolderCount === null) {
					return null;
				}
				fields.subfolderCount = subfolderCount;
			}
		}
		const safeFields = sanitizeJsonFields(fields);
		records.push({
			format: 'json',
			id: hashSourceId(`folder:${folderId}`),
			fields: safeFields,
		});
	}
	return records;
}

function findFolderChild(folder: HTMLElement, selector: string): HTMLElement | null {
	return folder.querySelectorAll(selector).find(element => element.closest('.folder') === folder) ?? null;
}

function parseSubfolderCount(value: string): number | null {
	const match = /^(\d+)(?:\s+Ordner)?$/u.exec(value);
	if (!match) {
		return null;
	}
	const count = Number(match[1]);
	return Number.isSafeInteger(count) ? count : null;
}

function normalizeSubstitutionDate(value: string): string | null {
	const normalized = value.replace(/^(\d{2})_(\d{2})_(\d{4})$/u, '$1.$2.$3');
	return isPortalDate(normalized) ? normalized : null;
}

function isPortalDate(value: string): boolean {
	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(value);
	if (!match) {
		return false;
	}
	const day = Number(match[1]);
	const month = Number(match[2]);
	const year = Number(match[3]);
	const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return month >= 1 && month <= 12 && day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

interface HtmlSpec {
	getTables(root: HTMLElement): { section: string; table: HTMLElement; printableRowsOnly?: boolean }[];
}

function htmlSpec(kind: PortalResourceKind): HtmlSpec | null {
	if (kind === 'timetable') {
		return { getTables: root => tablesInSections(root, TIMETABLE_SECTION_IDS) };
	}
	if (kind === 'learning-groups') {
		return { getTables: root => tablesInSections(root, ['LGs', 'klausuren']) };
	}
	if (kind === 'lessons') {
		return {
			getTables: root =>
				tablesInSections(root, LESSON_SECTION_IDS).map(table =>
					table.section === 'mappen' ? { ...table, printableRowsOnly: true } : table,
				),
		};
	}
	if (kind === 'file-metadata') {
		return {
			getTables: root =>
				allElements(root)
					.filter(element => element.tagName === 'TABLE' && element.getAttribute('id') === 'files')
					.map(table => ({ section: 'files', table })),
		};
	}
	return null;
}

function tablesInSections(root: HTMLElement, sectionIds: readonly string[]): { section: string; table: HTMLElement }[] {
	const sections = allElements(root).filter(element => sectionIds.includes(element.getAttribute('id') ?? ''));
	const result: { section: string; table: HTMLElement }[] = [];
	for (const section of sections) {
		for (const table of tablesWithin(section)) {
			if (nearestSection(table, sectionIds) === section) {
				result.push({ section: section.getAttribute('id') ?? '', table });
			}
		}
	}
	return result;
}

function allElements(root: HTMLElement): HTMLElement[] {
	return [root, ...root.querySelectorAll('*')];
}

function tablesWithin(section: HTMLElement): HTMLElement[] {
	return [...(section.tagName === 'TABLE' ? [section] : []), ...section.querySelectorAll('table')];
}

function isNestedTable(table: HTMLElement, section: HTMLElement): boolean {
	let current = table.parentNode;
	while (current && current !== section) {
		if (current.tagName === 'TABLE') {
			return true;
		}
		current = current.parentNode;
	}
	return false;
}

function nearestSection(element: HTMLElement, sectionIds: readonly string[]): HTMLElement | null {
	let current: HTMLElement | null = element;
	while (current) {
		if (sectionIds.includes(current.getAttribute('id') ?? '')) {
			return current;
		}
		current = current.parentNode;
	}
	return null;
}

function parseTable(
	table: HTMLElement,
	section: string,
	printableOnly: boolean,
	includeLessonDetails: boolean,
	omitUrls: boolean,
): TableResult {
	const rows = table.querySelectorAll('tr').filter(row => row.closest('table') === table);
	const headerRows: HTMLElement[] = [];
	const dataRows: HTMLElement[] = [];
	let encounteredData = false;

	for (const row of rows) {
		const cells = row.querySelectorAll(':scope > th, :scope > td');
		if (!cells.length) {
			continue;
		}
		const isInHead = row.closest('thead')?.closest('table') === table;
		const isLeadingHeader = !encounteredData && cells.every(cell => cell.tagName === 'TH');
		if (isInHead || isLeadingHeader) {
			headerRows.push(row);
		} else {
			encounteredData = true;
			if (!printableOnly || row.classList.contains('printable')) {
				dataRows.push(row);
			}
		}
	}

	const headers = headerRows.map(row =>
		row.querySelectorAll(':scope > th, :scope > td').map(cell => parseCell(cell, omitUrls)),
	);
	const primaryHeaders = headers.length === 1 ? headers[0].map(cell => cell.text) : [];
	const records = dataRows.map(row => {
		const cells = row.querySelectorAll(':scope > th, :scope > td').map(cell => parseCell(cell, omitUrls));
		const fields = cells.map((cell, index) => ({ ...cell, header: primaryHeaders[index] ?? null }));
		const rowAttributes = sanitizeAttributes(row.attributes, omitUrls);
		const dataId = row.getAttribute('data-id');
		const safeAttributes = omitUrls
			? {
					...Object.fromEntries(Object.entries(rowAttributes).filter(([name]) => name !== 'data-id')),
					...(dataId && /^\d+$/u.test(dataId) ? { 'data-id': dataId } : {}),
				}
			: rowAttributes;
		const courseId = includeLessonDetails ? getLessonCourseId(row) : undefined;
		const markers = includeLessonDetails ? getLessonMarkers(row) : [];
		const normalized = {
			headers: headers.map(headerRow => headerRow.map(cell => normalizeText(cell.text))),
			fields: fields.map(field => ({
				header: field.header === null ? null : normalizeText(field.header),
				text: normalizeText(field.text),
				links: field.links.map(normalizeLink),
				attributes: normalizeAttributes(field.attributes),
			})),
			attributes: normalizeAttributes(safeAttributes),
			...(courseId ? { courseId } : {}),
			markers,
		};
		return {
			format: 'html' as const,
			id: getHtmlId(row, normalized),
			section,
			attributes: safeAttributes,
			fields,
			...(markers.length > 0 ? { markers } : {}),
			...(courseId ? { courseId } : {}),
		};
	});
	const group = {
		section,
		tableAttributes: sanitizeAttributes(table.attributes, omitUrls),
		headers,
		recordIds: records.map(record => record.id),
	};
	return { group, records, confirmedStructure: records.length > 0 || headers.length > 0 };
}

function parseCell(cell: HTMLElement, omitUrls: boolean): PortalCell {
	return {
		header: null,
		text: getVisibleCellText(cell),
		links: cell
			.querySelectorAll('a')
			.filter(link => !hasHiddenAncestor(link, cell))
			.map(link => ({
				href: omitUrls ? null : safeRelativePath(link.getAttribute('href')),
				text: getVisibleCellText(link),
				attributes: sanitizeAttributes(link.attributes, omitUrls),
			})),
		attributes: sanitizeAttributes(cell.attributes, omitUrls),
	};
}

function getVisibleCellText(cell: HTMLElement): string {
	if (isHiddenElement(cell)) {
		return '';
	}
	const visibleCell = cell.clone() as HTMLElement;
	for (const hidden of visibleCell.querySelectorAll('[hidden], [aria-hidden="true"], .hidden, .hidden_encoded')) {
		hidden.remove();
	}
	for (const styled of visibleCell.querySelectorAll('[style]')) {
		const style = styled.getAttribute('style') ?? '';
		if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/iu.test(style)) {
			styled.remove();
		}
	}
	return visibleCell.text;
}

function isHiddenElement(element: HTMLElement): boolean {
	const style = element.getAttribute('style') ?? '';
	return (
		element.hasAttribute('hidden') ||
		element.getAttribute('aria-hidden') === 'true' ||
		element.classList.contains('hidden') ||
		element.classList.contains('hidden_encoded') ||
		/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/iu.test(style)
	);
}

function hasHiddenAncestor(element: HTMLElement, boundary: HTMLElement): boolean {
	let current: HTMLElement | null | undefined = element;
	while (current && current !== boundary) {
		if (isHiddenElement(current)) {
			return true;
		}
		current = current.parentNode;
	}
	return current !== boundary || isHiddenElement(boundary);
}

function getHtmlId(row: HTMLElement, normalized: unknown): string {
	const dataId = row.getAttribute('data-id');
	for (const sourceId of [
		row.getAttribute('id'),
		dataId && /^\d+$/u.test(dataId) ? dataId : undefined,
		row.getAttribute('data-entry'),
	]) {
		if (isSafeExplicitId(sourceId)) {
			return hashSourceId(sourceId);
		}
	}
	for (const link of row.querySelectorAll('a')) {
		const linkId = link.getAttribute('id');
		if (isSafeExplicitId(linkId)) {
			return hashSourceId(linkId);
		}
	}
	return hashId(normalized);
}

function getLessonCourseId(row: HTMLElement): string | undefined {
	for (const link of row.querySelectorAll('a')) {
		const courseId = parseLessonDetailHref(link.getAttribute('href'));
		if (courseId) {
			return courseId;
		}
	}
	return undefined;
}

function parseLessonDetailHref(href: string | undefined): string | null {
	if (!href || href.includes('#') || href.includes('\\') || hasControlCharacters(href)) {
		return null;
	}
	const match = /^(?:https:\/\/start\.schulportal\.hessen\.de)?(\/?meinunterricht\.php)\?a=view&id=(\d+)$/iu.exec(
		href,
	);
	if (!match) {
		return null;
	}
	try {
		const url = new URL(href, 'https://start.schulportal.hessen.de/');
		if (
			url.origin !== 'https://start.schulportal.hessen.de' ||
			url.pathname !== '/meinunterricht.php' ||
			url.search !== `?a=view&id=${match[2]}`
		) {
			return null;
		}
		return match[2];
	} catch {
		return null;
	}
}

function getLessonMarkers(row: HTMLElement): ('homework' | 'realHomework' | 'undone')[] {
	const classNames = ['homework', 'realHomework', 'undone'] as const;
	return classNames.filter(className =>
		[row, ...row.querySelectorAll('*')].some(element => element.classList.contains(className)),
	);
}

function isSafeExplicitId(value: string | undefined): value is string {
	if (!value?.trim() || value.includes('?') || value.includes('#') || hasControlCharacters(value)) {
		return false;
	}
	return (
		!/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(value) &&
		!/(?:session|sess(?:ion)?id|sid|token|cookie|csrf|auth|secret|password|credential|ticket)/iu.test(value)
	);
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f))) {
			return true;
		}
	}
	return false;
}

function safeRelativePath(value: string | undefined): string | null {
	if (
		!value ||
		value !== value.trim() ||
		value.includes('?') ||
		value.includes('#') ||
		value.includes('\\') ||
		hasControlCharacters(value)
	) {
		return null;
	}
	if (value.startsWith('//') || /^[a-z][a-z\d+.-]*:/iu.test(value)) {
		return null;
	}
	if (
		/(?:^|\/)(?:session|sessid|sid|token|auth|ticket|csrf|login|logout)(?:\/|$)/iu.test(value) ||
		/(?:jsessionid|sessionid|sessid|sid|token|csrf|auth|ticket)=/iu.test(value)
	) {
		return null;
	}
	try {
		return new URL(value, 'https://portal.invalid/').origin === 'https://portal.invalid' ? value : null;
	} catch {
		return null;
	}
}

function sanitizeAttributes(
	attributes: Readonly<Record<string, string>>,
	omitUrls = false,
): Readonly<Record<string, string>> {
	const safe: [string, string][] = [];
	for (const [name, value] of Object.entries(attributes)) {
		if (
			name === 'id' ||
			(omitUrls && name === 'data-id') ||
			/(?:session|sess(?:ion)?id|sid|token|cookie|csrf|auth|secret|password|credential|ticket)/iu.test(name)
		) {
			continue;
		}
		const isUrlAttribute = name === 'href' || /(?:^|[-_])(?:url|uri|link|src|href|action|download)$/iu.test(name);
		if (omitUrls && isUrlAttribute) {
			continue;
		}
		if (isUrlAttribute) {
			const path = safeRelativePath(value);
			if (path) {
				safe.push([name, path]);
			}
			continue;
		}
		if (
			/^(?:srcset|src|action|formaction|on\w+)$/iu.test(name) ||
			value.includes('?') ||
			hasControlCharacters(value) ||
			/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(value) ||
			/(?:https?:\/\/|\/\/\S+)/iu.test(value) ||
			/(?:^|[?&;,\s])(?:session|sessid|sid|token|cookie|csrf|auth|secret|password|credential|ticket)=/iu.test(
				value,
			)
		) {
			continue;
		}
		safe.push([name, value]);
	}
	return Object.fromEntries(safe);
}

function normalizeLink(link: PortalLink): PortalLink {
	return {
		href: link.href === null ? null : normalizeText(link.href),
		text: normalizeText(link.text),
		attributes: normalizeAttributes(link.attributes),
	};
}

function normalizeAttributes(attributes: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(attributes)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, value]) => [key, normalizeText(value)]),
	);
}

function normalizeText(value: string): string {
	return value.replace(/\s+/gu, ' ').trim();
}

function hashId(value: unknown): string {
	return `hash:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function hasLoginRequiredContent(root: HTMLElement): boolean {
	const visibleText = normalizeText(root.text).toLowerCase();
	if (
		/\blogin\s+nötig\b|\bmuss(?:\s+man)?\s+eingeloggt\s+sein\b|\blogin\s+required\b|\bmust\s+be\s+logged\s+in\b/u.test(
			visibleText,
		)
	) {
		return true;
	}
	return root.querySelectorAll('form').some(form => {
		const inputs = form.querySelectorAll('input');
		const names = inputs.map(input => input.getAttribute('name')?.toLowerCase() ?? '');
		const hasUser = names.some(name => ['user', 'user2', 'username', 'login'].includes(name));
		const hasPassword = inputs.some(
			input =>
				input.getAttribute('type')?.toLowerCase() === 'password' ||
				input.getAttribute('name')?.toLowerCase() === 'password',
		);
		return hasPassword && (hasUser || /login|anmeld/i.test(form.getAttribute('action') ?? ''));
	});
}

function hasPermissionDenial(text: string): boolean {
	return /\bkeine\s+(?:zugriffs)?berechtigung\b|\bzugriff\s+verweigert\b|\bnot\s+authorized\b|\baccess\s+denied\b|\bpermission\s+denied\b/u.test(
		text,
	);
}

function hasFeatureUnavailable(text: string): boolean {
	return /\b(?:funktion|bereich|modul|feature)\b.{0,48}\b(?:nicht\s+verfügbar|nicht\s+freigeschaltet|deaktiviert)\b|\b(?:funktion|bereich|modul|feature)\b.{0,48}\b(?:not\s+available|not\s+enabled|disabled)\b/u.test(
		text,
	);
}
