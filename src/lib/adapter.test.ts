import { createHash } from 'node:crypto';
import { expect } from 'chai';
import Module, { createRequire } from 'node:module';
import type { SchulportalHessenAdapter as AdapterClass } from './adapter';
import type {
	ChildLessonRecordSection,
	PortalChildLessons,
	PortalChildTimetable,
	PortalParseResult,
	PortalRecord,
	PortalResourceKind,
} from './portal-parser';
import type { PortalResponse } from './portal-session';
import { allocateIdPathSegments } from './id-path-segments';

const loadModule = createRequire(__filename);
const moduleLoader = Module as unknown as {
	_load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
	if (request === '@iobroker/adapter-core') {
		return {
			Adapter: class {
				on(): void {}
			},
		};
	}
	return originalLoad.call(Module, request, parent, isMain);
};
let adapterModule: { SchulportalHessenAdapter: typeof AdapterClass };
try {
	adapterModule = loadModule('./adapter') as typeof adapterModule;
} finally {
	moduleLoader._load = originalLoad;
}
const { SchulportalHessenAdapter } = adapterModule;

interface TestAdapter {
	config: Pick<ioBroker.AdapterConfig, 'schoolId' | 'credentialId' | 'accountName'> & {
		refreshIntervalMinutes?: number;
	};
	namespace: string;
	onReady(): Promise<void>;
	onUnload(callback: () => void): Promise<void>;
	refreshAccount(): Promise<void>;
	setTimeout(callback: () => void, delay: number): ioBroker.Timeout;
	clearTimeout(timer: ioBroker.Timeout): void;
	subscribeStates(id: string): void;
	terminate(reason: string, code: number): void;
	log: { debug(message: string): void; warn(message: string): void; error(message: string): void };
	onStateChange(id: string, state: ioBroker.State | null | undefined): void;
	requestRefresh(): Promise<void>;
	getObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
	setObjectNotExistsAsync(id: string, object: ioBroker.SettableObject): Promise<void>;
	extendObjectAsync(id: string, object: ioBroker.PartialObject): Promise<void>;
	getStateAsync(id: string): Promise<ioBroker.State | null | undefined>;
	setStateAsync(id: string, state: ioBroker.SettableState): Promise<void>;
	delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<void>;
	commitChildLessons(children: readonly PortalChildLessons[]): Promise<boolean>;
	createObjectTree(): Promise<void>;
	getBerlinToday(): string;
	refreshResource(
		resource: PortalResourceKind,
		read: () => Promise<PortalResponse>,
		parse?: () => PortalParseResult,
	): Promise<{ success: boolean; degraded: boolean; status: string }>;
}

interface StoredObject {
	_id: string;
	type: string;
	common: Record<string, unknown>;
	native: Record<string, unknown>;
}

function makeTestAdapter(): {
	adapter: TestAdapter;
	objects: Map<string, StoredObject>;
	states: Map<string, ioBroker.State>;
} {
	const adapter = new SchulportalHessenAdapter() as unknown as TestAdapter;
	adapter.config = { schoolId: '5202', credentialId: 'system.credentials.test-credential' };
	adapter.log = { debug: () => undefined, warn: () => undefined, error: () => undefined };
	const objects = new Map<string, StoredObject>();
	const states = new Map<string, ioBroker.State>();

	adapter.getObjectAsync = id => Promise.resolve((objects.get(id) as unknown as ioBroker.Object | undefined) ?? null);
	adapter.setObjectNotExistsAsync = (id, object) => {
		if (!objects.has(id)) {
			objects.set(id, { _id: id, ...(object as unknown as Omit<StoredObject, '_id'>) });
		}
		return Promise.resolve();
	};
	adapter.extendObjectAsync = (id, partial) => {
		const existing = objects.get(id);
		if (!existing) {
			return Promise.reject(new Error('Object does not exist'));
		}
		const update = partial as unknown as Partial<StoredObject>;
		objects.set(id, {
			...existing,
			...update,
			common: { ...existing.common, ...update.common },
			native: { ...existing.native, ...update.native },
		});
		return Promise.resolve();
	};
	adapter.getStateAsync = id => Promise.resolve(states.get(id) ?? null);
	adapter.setStateAsync = (id, state) => {
		states.set(id, { ...states.get(id), ...state } as ioBroker.State);
		return Promise.resolve();
	};
	adapter.delObjectAsync = (id, options) => {
		for (const key of new Set([...objects.keys(), ...states.keys()])) {
			if (key === id || (options?.recursive && key.startsWith(`${id}.`))) {
				objects.delete(key);
				states.delete(key);
			}
		}
		return Promise.resolve();
	};

	return { adapter, objects, states };
}

function child(id: string, name: string): PortalChildLessons {
	return childWithRecords(id, name, [lessonRecord('b', id, 'child-lessons')]);
}

function childWithRecords(
	id: string,
	name: string,
	records: readonly PortalRecord[],
	sections?: PortalChildLessons['sections'],
): PortalChildLessons {
	return { id, name, records, ...(sections === undefined ? {} : { sections }) };
}

function lessonRecord(
	uniqueId: string,
	childId: string,
	section: string,
	childSection?: ChildLessonRecordSection,
): PortalRecord {
	return {
		format: 'html',
		id: `hash:${uniqueId.repeat(64)}`,
		section,
		attributes: {},
		fields: [],
		context: { childId },
		...(childSection ? { childSection } : {}),
	};
}

function timetableRecord(uniqueId: string, childId: string, day: string, subject: string): PortalRecord {
	return {
		format: 'html',
		id: `timetable:${uniqueId.repeat(64)}`,
		section: 'own',
		attributes: {},
		fields: [
			{ header: 'Day', text: day, links: [], attributes: {} },
			{ header: 'Subject', text: subject, links: [], attributes: {} },
		],
		context: { childId },
	};
}

function timetableWeekdayRecord(uniqueId: string, childId: string, weekday: string, subject: string): PortalRecord {
	return {
		format: 'html',
		id: `timetable:${uniqueId.repeat(64)}`,
		section: 'own',
		attributes: {},
		fields: [
			{ header: 'Period', text: '1', links: [], attributes: {} },
			{ header: 'Subject', text: subject, links: [], attributes: {} },
		],
		context: { childId, timetableWeekday: weekday },
	};
}

function htmlLessonRecord(
	id: string,
	childId: string,
	fields: readonly { header: string | null; text: string }[],
): Extract<PortalRecord, { format: 'html' }> {
	return {
		format: 'html',
		id: `hash:${id.repeat(64)}`,
		section: 'current',
		attributes: {},
		fields: fields.map(field => ({ ...field, links: [], attributes: {} })),
		context: { childId },
	};
}

function jsonLessonRecord(id: string, childId: string, fields: Readonly<Record<string, unknown>>): PortalRecord {
	return { format: 'json', id: `json:${id.repeat(64)}`, fields, context: { childId } };
}

function jsonRecord(id: string, fields: Readonly<Record<string, unknown>>): PortalRecord {
	return { format: 'json', id: `json:${id}`, fields };
}

function state(value: string | number | boolean): ioBroker.State {
	return { val: value, ack: true } as ioBroker.State;
}

function readableChildBase(sourceId: string, displayName: string): string {
	const segment = allocateIdPathSegments([{ sourceId, displayName }]).get(sourceId);
	if (!segment) {
		throw new Error('Missing readable child segment');
	}
	return `students.${segment}`;
}

function readableRecordPath(states: Map<string, ioBroker.State>, base: string, sourceId: string): string {
	const value = JSON.parse(String(states.get(`${base}.recordPaths`)?.val)) as Record<string, string | string[]>;
	const path = value[sourceId];
	if (Array.isArray(path)) {
		return path[0] ?? '';
	}
	return path ?? '';
}

describe('manual refresh state', () => {
	it('accepts a fully qualified refresh ID and refreshes only for an unacknowledged true value', () => {
		const { adapter, states } = makeTestAdapter();
		adapter.namespace = 'schulportal-hessen.0';
		let refreshRequests = 0;
		adapter.requestRefresh = () => {
			refreshRequests++;
			return Promise.resolve();
		};
		const id = `${adapter.namespace}.info.refresh`;

		adapter.onStateChange(id, { val: false, ack: false } as ioBroker.State);
		adapter.onStateChange(id, { val: true, ack: true } as ioBroker.State);
		adapter.onStateChange(id, { val: true, ack: false } as ioBroker.State);

		expect(refreshRequests).to.equal(1);
		expect(states.get('info.refresh')).to.deep.include({ val: false, ack: true });
		expect(states.has(`${id}`)).to.equal(false);
	});
});

function makePollingAdapter(): ReturnType<typeof makeTestAdapter> & {
	timers: Map<ioBroker.Timeout, { callback: () => void; delay: number }>;
} {
	const harness = makeTestAdapter();
	const { adapter } = harness;
	const timers = new Map<ioBroker.Timeout, { callback: () => void; delay: number }>();
	adapter.setTimeout = (callback, delay) => {
		const timer = {} as ioBroker.Timeout;
		timers.set(timer, { callback, delay });
		return timer;
	};
	adapter.clearTimeout = timer => {
		timers.delete(timer);
	};
	adapter.subscribeStates = () => undefined;
	adapter.terminate = () => {
		throw new Error('Adapter unexpectedly terminated');
	};
	return { ...harness, timers };
}

function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe('completion-based refresh scheduling', () => {
	it('starts a new full interval only after startup, manual and scheduled refreshes settle', async () => {
		const { adapter, timers } = makePollingAdapter();
		adapter.config.refreshIntervalMinutes = 5;
		const starts = [deferred(), deferred(), deferred()];
		const finishes = [deferred(), deferred(), deferred()];
		let runs = 0;
		adapter.refreshAccount = () => {
			const run = runs++;
			starts[run].resolve();
			return finishes[run].promise;
		};

		const ready = adapter.onReady();
		await starts[0].promise;
		expect(timers.size).to.equal(0);
		finishes[0].reject(new Error('Initial refresh failed'));
		await ready;
		expect([...timers.values()].map(timer => timer.delay)).to.deep.equal([300_000]);
		const [initialTimer] = timers.keys();

		adapter.onStateChange('info.refresh', { val: true, ack: false } as ioBroker.State);
		await starts[1].promise;
		expect(timers.size).to.equal(0);
		const manual = adapter.requestRefresh();
		expect(adapter.requestRefresh()).to.equal(manual);
		finishes[1].resolve();
		await manual;
		expect([...timers.values()].map(timer => timer.delay)).to.deep.equal([300_000]);
		const [[scheduledTimer, scheduled]] = [...timers];
		expect(scheduledTimer).not.to.equal(initialTimer);
		timers.delete(scheduledTimer);
		scheduled.callback();
		await starts[2].promise;
		expect(timers.size).to.equal(0);
		const running = adapter.requestRefresh();
		finishes[2].resolve();
		await running;
		expect(runs).to.equal(3);
		expect([...timers.values()].map(timer => timer.delay)).to.deep.equal([300_000]);
		await adapter.onUnload(() => undefined);
		expect(timers.size).to.equal(0);
	});

	it('does not rearm when unloaded during a refresh or when no account is configured', async () => {
		const { adapter, timers } = makePollingAdapter();
		const started = deferred();
		const finished = deferred();
		adapter.refreshAccount = () => {
			started.resolve();
			return finished.promise;
		};
		const ready = adapter.onReady();
		await started.promise;
		let unloads = 0;
		const unloaded = adapter.onUnload(() => {
			unloads++;
		});
		expect(unloads).to.equal(0);
		finished.resolve();
		await Promise.all([ready, unloaded]);
		await adapter.requestRefresh();
		expect(unloads).to.equal(1);
		expect(timers.size).to.equal(0);

		const unconfigured = makePollingAdapter();
		unconfigured.adapter.config = { schoolId: '', credentialId: '' };
		await unconfigured.adapter.onReady();
		await unconfigured.adapter.requestRefresh();
		expect(unconfigured.timers.size).to.equal(0);
	});
});

describe('new root object tree', () => {
	it('creates the requested top-level paths without creating account objects', async () => {
		const { adapter, objects } = makeTestAdapter();
		await adapter.createObjectTree();

		for (const id of [
			'info',
			'profile',
			'calendar',
			'calendar.portal',
			'calendar.school',
			'inbox',
			'inbox.read',
			'inbox.unread',
			'files',
			'learningGroups',
			'substitutions',
			'students',
			'students.timetable',
			'students.lessons',
		]) {
			expect(objects.get(id)?.type, `${id} exists`).to.equal('channel');
		}
		for (const id of ['info.accountType', 'profile.name', 'profile.school']) {
			expect(objects.get(id)?.type, `${id} exists`).to.equal('state');
		}
		expect(objects.has('account')).to.equal(false);
		expect(objects.has('account.info.schoolId')).to.equal(false);
	});

	it('publishes only the optional configured account display name and clears a stale value', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		adapter.config.accountName = '  Familienkonto  ';
		await adapter.createObjectTree();
		expect(objects.get('info.accountName')?.common).to.include({ type: 'string', read: true, write: false });
		expect(states.get('info.accountName')).to.deep.include({ val: 'Familienkonto', ack: true });

		delete adapter.config.accountName;
		await adapter.createObjectTree();
		expect(states.get('info.accountName')).to.deep.include({ val: '', ack: true });
	});

	it('maps verified profile labels and account type to the root summary states', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html',
			body: Buffer.from('<html></html>'),
		};
		const result = await adapter.refreshResource(
			'account',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'account',
				records: [
					jsonRecord('name', { recordType: 'profile', label: 'Name', value: 'Synthetic Student' }),
					jsonRecord('school', { recordType: 'profile', label: 'Schule', value: 'Example School' }),
					jsonRecord('type', { recordType: 'account-type', type: 'student' }),
				],
				groups: [],
			}),
		);

		expect(result.success).to.equal(true);
		expect(states.get('info.accountType')?.val).to.equal('student');
		expect(states.get('profile.name')?.val).to.equal('Synthetic Student');
		expect(states.get('profile.school')?.val).to.equal('Example School');
		expect(states.get('profile.count')?.val).to.equal(2);
		expect(objects.get('profile.field-name')?.type).to.equal('channel');
		expect(objects.has('profile.name') && objects.get('profile.name')?.type === 'channel').to.equal(false);

		await adapter.refreshResource(
			'account',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'account',
				records: [
					jsonRecord('name-1', { recordType: 'profile', label: 'Name', value: 'First candidate' }),
					jsonRecord('name-2', { recordType: 'profile', label: 'Name', value: 'Second candidate' }),
				],
				groups: [],
			}),
		);
		expect(states.get('profile.name')?.val).to.equal('');
		expect(states.get('info.accountType')?.val).to.equal('');
	});
});

describe('calendar resource filtering', () => {
	for (const resource of ['calendar', 'school-calendar'] as const) {
		it(`keeps only current dated events and sorts readable channel IDs for ${resource}`, async () => {
			const { adapter, objects, states } = makeTestAdapter();
			adapter.getBerlinToday = () => '2026-11-11';
			await adapter.createObjectTree();
			const fields =
				resource === 'calendar'
					? [
							{ starts_at: '2026-11-10T23:30:00Z', title: 'Today Event' },
							{ starts_at: '2026-11-01', ends_at: '2026-11-12', title: 'Ongoing Event' },
							{ starts_at: '2026-11-12', title: 'Future Event' },
							{ starts_at: '2026-11-01', ends_at: '2026-11-11', title: 'Ends Today Event' },
							{ starts_at: '2026-11-09', title: 'Past Event' },
							{ title: 'Undated Event' },
							{ starts_at: '2026-11-13', ends_at: 'not-a-date', title: 'Invalid End' },
						]
					: [
							{
								start: '2026-11-11T09:00:00+01:00',
								end: '2026-11-11T10:00:00+01:00',
								summary: 'Today Event',
							},
							{ start: '2026-11-01', end: '2026-11-12', summary: 'Ongoing Event' },
							{ start: '2026-11-12', end: '2026-11-12', summary: 'Future Event' },
							{ start: '2026-11-01', end: '2026-11-11', summary: 'Ends Today Event' },
							{ start: '2026-11-09', end: '2026-11-10', summary: 'Past Event' },
							{
								start: '2026-11-01',
								end: '2026-11-11',
								start_type: 'DATE',
								end_type: 'DATE',
								summary: 'Ended Yesterday',
							},
							{ start: '2026-02-30', end: '2026-03-01', summary: 'Invalid Event' },
							{ start: '2026-11-13', end: 'not-a-date', summary: 'Invalid End' },
						];
			const records = fields.map((event, index) => jsonRecord(`event-${index}`, event));
			const response: PortalResponse = {
				status: 200,
				classification: 'success',
				contentType: 'application/json',
				body: Buffer.from('[]'),
			};

			const result = await adapter.refreshResource(
				resource,
				() => Promise.resolve(response),
				() => ({
					status: 'complete',
					kind: resource,
					records,
					groups: [],
				}),
			);

			expect(result.success).to.equal(true);
			const base = resource === 'calendar' ? 'calendar.portal' : 'calendar.school';
			const savedRecords = JSON.parse(String(states.get(`${base}.json`)?.val)) as PortalRecord[];
			expect(savedRecords.map(record => record.id)).to.deep.equal(records.slice(0, 4).map(record => record.id));
			expect(savedRecords[0]?.format === 'json' && savedRecords[0].fields).to.deep.equal(fields[0]);
			expect(states.get(`${base}.count`)?.val).to.equal(4);
			const mapping = JSON.parse(String(states.get(`${base}.recordPaths`)?.val)) as Record<string, string[]>;
			const paths = Object.values(mapping).flat().sort();
			expect(paths).to.deep.equal([
				'2026-11-01-ends-today-event',
				'2026-11-01-ongoing-event',
				'2026-11-11-today-event',
				'2026-11-12-future-event',
			]);
			expect(paths.every(path => /^\d{4}-\d{2}-\d{2}-/u.test(path))).to.equal(true);
			for (const path of paths) {
				expect(objects.get(`${base}.${path}`)?.type).to.equal('channel');
			}

			const stalePath = paths[0];
			const emptyResult = await adapter.refreshResource(
				resource,
				() => Promise.resolve(response),
				() => ({
					status: 'complete',
					kind: resource,
					records: [jsonRecord(`undated-${resource}`, { title: 'Still undated' })],
					groups: [],
				}),
			);
			expect(emptyResult.success).to.equal(true);
			expect(states.get(`${base}.count`)?.val).to.equal(0);
			expect(states.get(`${base}.json`)?.val).to.equal('[]');
			expect(objects.has(`${base}.${stalePath}`)).to.equal(false);
		});
	}

	it('drops undatable school-calendar CSV rows without invalidating dated events', async () => {
		const { adapter, states } = makeTestAdapter();
		adapter.getBerlinToday = () => '2026-11-11';
		await adapter.createObjectTree();
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/csv',
			body: Buffer.from(
				'Start,End,Title\r\n,2026-11-12,Missing date\r\nnot-a-date,2026-11-20,Invalid date\r\n2026-11-12,2026-11-12,Future event',
			),
		};

		const result = await adapter.refreshResource('school-calendar', () => Promise.resolve(response));

		expect(result.success).to.equal(true);
		expect(states.get('calendar.school.count')?.val).to.equal(1);
		expect(states.get('calendar.school.json')?.val).to.contain('Future event');
		expect(states.get('calendar.school.json')?.val).not.to.contain('Missing date');
		expect(states.get('calendar.school.json')?.val).not.to.contain('Invalid date');
	});
});

describe('compact resource records', () => {
	const records: Array<{
		resource: Extract<PortalResourceKind, 'calendar' | 'school-calendar' | 'file-metadata'>;
		base: string;
		record: PortalRecord;
	}> = [
		{
			resource: 'calendar',
			base: 'calendar.portal',
			record: jsonRecord('portal-event', {
				starts_at: '2026-11-12T09:00:00+01:00',
				title: 'Sports day',
				location: { building: 'Main hall' },
			}),
		},
		{
			resource: 'school-calendar',
			base: 'calendar.school',
			record: jsonRecord('school-event', {
				start: '2026-11-12',
				end: '2026-11-12',
				summary: 'School event',
			}),
		},
		{
			resource: 'file-metadata',
			base: 'files',
			record: jsonRecord('file-entry', {
				name: 'Annual report',
				size: 2048,
				metadata: { mediaType: 'application/pdf' },
			}),
		},
	];

	for (const { resource, base, record } of records) {
		it(`stores the complete record in one read-only JSON state for ${resource}`, async () => {
			const { adapter, objects, states } = makeTestAdapter();
			adapter.getBerlinToday = () => '2026-11-11';
			await adapter.createObjectTree();
			const response: PortalResponse = {
				status: 200,
				classification: 'success',
				contentType: 'application/json',
				body: Buffer.from('[]'),
			};

			const result = await adapter.refreshResource(
				resource,
				() => Promise.resolve(response),
				() => ({ status: 'complete', kind: resource, records: [record], groups: [] }),
			);

			expect(result.success).to.equal(true);
			expect(states.get(`${base}.count`)?.val).to.equal(1);
			expect(states.get(`${base}.json`)?.val).to.equal(JSON.stringify([record]));
			const manifest = JSON.parse(String(states.get(`${base}.recordIds`)?.val)) as string[];
			const recordPath = readableRecordPath(states, base, manifest[0] ?? '');
			const channelId = `${base}.${recordPath}`;
			expect(objects.get(channelId)?.type).to.equal('channel');
			expect(states.get(`${channelId}.record_json`)?.val).to.equal(JSON.stringify(record));
			expect(objects.get(`${channelId}.record_json`)?.common).to.include({
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			});
			expect(objects.get(channelId)?.native.portalRecordFieldIds).to.deep.equal(['record_json']);
			expect([...objects.keys()].filter(id => id.startsWith(`${channelId}.`))).to.deep.equal([
				`${channelId}.record_json`,
			]);
		});
	}

	it('repairs existing record channels missing type or common before writing fields', async () => {
		for (const testCase of [
			{ common: undefined, expectedName: 'Annual report' },
			{ common: { name: 'Custom report label' }, expectedName: 'Custom report label' },
			{
				common: { name: { en: 'My report', de: 'Mein Bericht' } },
				expectedName: { en: 'My report', de: 'Mein Bericht' },
			},
		]) {
			const { adapter, objects, states } = makeTestAdapter();
			await adapter.createObjectTree();
			const record = jsonRecord('corrupt-existing-record', { name: 'Annual report', size: 1024 });
			const sourceId = createHash('sha256').update(record.id).digest('hex');
			const channelId = 'files.annual-report';
			const existingChannel = {
				_id: channelId,
				native: { portalRecordFieldIds: ['record_json'] },
				...(testCase.common ? { common: testCase.common } : {}),
			};
			objects.set(channelId, existingChannel as unknown as StoredObject);
			const recordJsonId = `${channelId}.record_json`;
			objects.set(recordJsonId, {
				_id: recordJsonId,
				type: 'state',
				common: { name: 'Complete record (JSON)', type: 'string', role: 'json', read: true, write: false },
				native: { portalRecordFieldDisplayName: 'Complete record (JSON)' },
			});
			states.set(recordJsonId, state('stale record'));
			const originalSetState = adapter.setStateAsync;
			adapter.setStateAsync = (id, value) => {
				if (id === recordJsonId) {
					expect(objects.get(channelId)?.type).to.equal('channel');
					expect(objects.get(channelId)?.common.name).to.deep.equal(testCase.expectedName);
				}
				return originalSetState(id, value);
			};
			const response: PortalResponse = {
				status: 200,
				classification: 'success',
				contentType: 'application/json',
				body: Buffer.from('[]'),
			};

			const result = await adapter.refreshResource(
				'file-metadata',
				() => Promise.resolve(response),
				() => ({ status: 'complete', kind: 'file-metadata', records: [record], groups: [] }),
			);

			expect(result.success).to.equal(true);
			expect(objects.get(channelId)?.type).to.equal('channel');
			expect(objects.get(channelId)?.common.name).to.deep.equal(testCase.expectedName);
			expect(objects.get(channelId)?.native.portalRecordFieldIds).to.deep.equal(['record_json']);
			expect(states.get(recordJsonId)?.val).to.equal(JSON.stringify(record));
			expect(states.get('files.recordIds')?.val).to.equal(JSON.stringify([sourceId]));
		}
	});

	it('allocates records away from fixed resource states and protects those objects during cleanup', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const base = 'files';
		const names = ['status', 'STATUS', 'count', 'lastUpdate', 'json', 'recordIds', 'recordPaths', 'records'];
		const records = names.map((name, index) => jsonRecord(`reserved-${index}`, { name, marker: index }));
		const sourceIds = records.map(record => createHash('sha256').update(record.id).digest('hex'));
		const previousPaths = Object.fromEntries(
			records.map((_, index) => [sourceIds[index], [names[index]?.toLowerCase() ?? '']]),
		);
		states.set(`${base}.recordIds`, state(JSON.stringify(sourceIds)));
		states.set(`${base}.recordPaths`, state(JSON.stringify(previousPaths)));
		objects.set(`${base}.records`, {
			_id: `${base}.records`,
			type: 'channel',
			common: { name: 'Legacy records' },
			native: {},
		});
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};

		const result = await adapter.refreshResource(
			'file-metadata',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'file-metadata', records, groups: [] }),
		);

		expect(result.success).to.equal(true);
		expect(states.get(`${base}.status`)?.val).to.equal('complete');
		expect(states.get(`${base}.count`)?.val).to.equal(records.length);
		expect(states.get(`${base}.lastUpdate`)?.val)
			.to.be.a('number')
			.and.greaterThan(0);
		expect(states.get(`${base}.json`)?.val).to.equal(JSON.stringify(records));
		expect(JSON.parse(String(states.get(`${base}.recordIds`)?.val))).to.deep.equal([...sourceIds].sort());
		const currentPaths = JSON.parse(String(states.get(`${base}.recordPaths`)?.val)) as Record<string, string[]>;
		const reservedPaths = new Set(names.map(name => name.toLowerCase()));
		for (const [index, record] of records.entries()) {
			const sourceId = sourceIds[index];
			const recordPath = sourceId ? currentPaths[sourceId]?.[0] : undefined;
			expect(recordPath).to.be.a('string');
			expect(reservedPaths.has(recordPath?.toLowerCase() ?? '')).to.equal(false);
			const channelId = `${base}.${recordPath}`;
			expect(objects.get(channelId)?.type).to.equal('channel');
			expect(states.get(`${channelId}.record_json`)?.val).to.equal(JSON.stringify(record));
		}
		for (const fixedName of ['status', 'count', 'lastUpdate', 'json', 'recordIds', 'recordPaths']) {
			expect(objects.get(`${base}.${fixedName}`)?.type, fixedName).to.equal('state');
			expect(objects.has(`${base}.${fixedName}.record_json`), fixedName).to.equal(false);
		}
		expect(objects.has(`${base}.records`)).to.equal(false);
		const firstPathMapping = states.get(`${base}.recordPaths`)?.val;
		const repeated = await adapter.refreshResource(
			'file-metadata',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'file-metadata', records, groups: [] }),
		);
		expect(repeated.success).to.equal(true);
		expect(states.get(`${base}.recordPaths`)?.val).to.equal(firstPathMapping);
	});

	it('retries only owned tracked fields left under a colliding fixed state', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const fixedId = 'files.status';
		const fieldId = `${fixedId}.record_json`;
		const sourceId = 'legacy-status';
		const fixed = objects.get(fixedId)!;
		fixed.native.portalRecordFieldIds = ['record_json', 'manual', 'folder', 'folder.nested'];
		states.set('files.recordIds', state(JSON.stringify([sourceId])));
		states.set('files.recordPaths', state(JSON.stringify({ [sourceId]: ['status', 'status.manual'] })));
		for (const [suffix, type, owned] of [
			['record_json', 'state', true],
			['record_json.user', 'state', false],
			['manual', 'state', false],
			['untracked', 'state', true],
			['folder', 'channel', true],
			['folder.nested', 'state', true],
		] as const) {
			const id = `${fixedId}.${suffix}`;
			objects.set(id, {
				_id: id,
				type,
				common: { name: suffix },
				native: owned ? { portalRecordFieldDisplayName: suffix } : {},
			});
			if (type === 'state') {
				states.set(id, state(suffix));
			}
		}
		const originalDelete = adapter.delObjectAsync;
		let failures = 0;
		adapter.delObjectAsync = (id, options) => {
			if (id === fieldId) {
				expect(options?.recursive).not.to.equal(true);
				if (failures++ === 0) {
					return Promise.reject(new Error('Temporary delete failure'));
				}
			}
			return originalDelete(id, options);
		};
		const refresh = (): ReturnType<TestAdapter['refreshResource']> =>
			adapter.refreshResource(
				'file-metadata',
				() =>
					Promise.resolve({
						status: 200,
						classification: 'success',
						contentType: 'application/json',
						body: Buffer.from('[]'),
					}),
				() => ({ status: 'complete', kind: 'file-metadata', records: [], groups: [] }),
			);

		expect(await refresh()).to.deep.equal({ success: true, degraded: true, status: 'complete-cleanup-pending' });
		expect(states.get('files.recordIds')?.val).to.equal(JSON.stringify([sourceId]));
		expect(states.get('files.recordPaths')?.val).to.equal(JSON.stringify({ [sourceId]: ['status'] }));
		expect(objects.has(fieldId)).to.equal(true);

		expect(await refresh()).to.deep.equal({ success: true, degraded: false, status: 'complete' });
		expect(states.get('files.recordIds')?.val).to.equal('[]');
		expect(states.get('files.recordPaths')?.val).to.equal('{}');
		expect(objects.has(fieldId)).to.equal(false);
		expect(states.has(fieldId)).to.equal(false);
		expect(objects.get(fixedId)?.type).to.equal('state');
		expect(states.get(fixedId)?.val).to.equal('complete');
		for (const suffix of ['record_json.user', 'manual', 'untracked', 'folder', 'folder.nested']) {
			expect(objects.has(`${fixedId}.${suffix}`), suffix).to.equal(true);
		}
	});

	it('cleans tracked legacy fields from a fixed lesson section without deleting its status', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const student = childWithRecords('a'.repeat(64), 'Learner', [], ['attendance']);
		await adapter.commitChildLessons([student]);
		const base = 'students.learner.lessons';
		const section = `${base}.attendance`;
		const legacyField = `${section}.anwesend`;
		const status = `${section}.status`;
		objects.get(section)!.native.portalRecordFieldIds = ['anwesend', 'status'];
		objects.get(status)!.native.portalRecordFieldDisplayName = 'Old colliding label';
		objects.set(legacyField, {
			_id: legacyField,
			type: 'state',
			common: { name: 'Anwesend' },
			native: { portalRecordFieldDisplayName: 'Anwesend' },
		});
		states.set(legacyField, state('Yes'));
		states.set(`${base}.recordIds`, state('["legacy-attendance"]'));
		states.set(`${base}.recordPaths`, state('{"legacy-attendance":["attendance"]}'));

		await adapter.commitChildLessons([student]);

		expect(objects.has(legacyField)).to.equal(false);
		expect(states.has(legacyField)).to.equal(false);
		expect(objects.get(section)?.type).to.equal('channel');
		expect(objects.get(status)?.type).to.equal('state');
		expect(states.get(status)?.val).to.equal('complete');
		expect(states.get(`${base}.recordPaths`)?.val).to.equal('{}');
	});

	it('removes only old field objects listed in channel tracking', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const channelId = 'files.current-report';
		objects.set(channelId, {
			_id: channelId,
			type: 'channel',
			common: { name: 'Current report' },
			native: { portalRecordDisplayName: 'Current report', portalRecordFieldIds: ['name', 'size'] },
		});
		for (const fieldId of ['name', 'size', 'untracked']) {
			const id = `${channelId}.${fieldId}`;
			objects.set(id, {
				_id: id,
				type: 'state',
				common: { name: fieldId },
				native: {},
			});
			states.set(id, state(fieldId));
		}
		const record = jsonRecord('current-report', { name: 'Current report', size: 2048 });
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};

		const result = await adapter.refreshResource(
			'file-metadata',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'file-metadata', records: [record], groups: [] }),
		);

		expect(result.success).to.equal(true);
		for (const fieldId of ['name', 'size']) {
			expect(objects.has(`${channelId}.${fieldId}`)).to.equal(false);
			expect(states.has(`${channelId}.${fieldId}`)).to.equal(false);
		}
		expect(objects.has(`${channelId}.untracked`)).to.equal(true);
		expect(states.get(`${channelId}.untracked`)?.val).to.equal('untracked');
		expect(states.get(`${channelId}.record_json`)?.val).to.equal(JSON.stringify(record));
		expect(objects.get(channelId)?.native.portalRecordFieldIds).to.deep.equal(['record_json']);
	});
});

describe('non-compacted resource records', () => {
	it('uses an English section label without changing the protocol-based channel path or aggregate', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const record: PortalRecord = {
			format: 'html',
			id: 'exam-row',
			section: 'klausuren',
			attributes: {},
			fields: [{ header: 'Fach', text: 'Englisch', links: [], attributes: {} }],
		};
		const result = await adapter.refreshResource(
			'learning-groups',
			() =>
				Promise.resolve({
					status: 200,
					classification: 'success',
					contentType: 'text/html',
					body: Buffer.from(''),
				}),
			() => ({ status: 'complete', kind: 'learning-groups', records: [record], groups: [] }),
		);

		expect(result.success).to.equal(true);
		const channel = 'learningGroups.klausuren-englisch';
		expect(objects.get(channel)?.common.name).to.equal('Exams — Englisch');
		expect(states.get(`${channel}.subject`)?.val).to.equal('Englisch');
		expect(states.get('learningGroups.json')?.val).to.equal(JSON.stringify([record]));
	});

	it('continues exposing individual typed field states', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const record = jsonRecord('substitution', { name: 'Exam', room: 'A12', confirmed: false });
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};

		const result = await adapter.refreshResource(
			'substitutions',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'substitutions', records: [record], groups: [] }),
		);

		expect(result.success).to.equal(true);
		const channelId = 'substitutions.undated.portal-record';
		expect(states.get(`${channelId}.name`)?.val).to.equal('Exam');
		expect(states.get(`${channelId}.room`)?.val).to.equal('A12');
		expect(states.get(`${channelId}.confirmed`)?.val).to.equal(false);
		expect(objects.get(`${channelId}.confirmed`)?.common).to.include({
			type: 'boolean',
			role: 'indicator',
			read: true,
			write: false,
		});
		expect(objects.has(`${channelId}.record_json`)).to.equal(false);
	});

	it('adds individual substitution column text states without replacing aggregate fields', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const columns = [
			{ header: 'Subject', value: 'Mathematics' },
			{ header: 'Subject!', value: 'English' },
			{ header: 'Subject', value: 'History' },
			{ header: '', value: '' },
		];
		const record = jsonRecord('substitution-columns', {
			name: 'Exam',
			portalDate: '12.11.2026',
			columns,
		});
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};

		const result = await adapter.refreshResource(
			'substitutions',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'substitutions', records: [record], groups: [] }),
		);

		expect(result.success).to.equal(true);
		const sourceId = createHash('sha256').update(record.id).digest('hex');
		const channelId = `substitutions.${readableRecordPath(states, 'substitutions', sourceId)}`;
		expect(states.get(`${channelId}.portaldate`)?.val).to.equal('12.11.2026');
		expect(states.get(`${channelId}.columns`)?.val).to.equal(JSON.stringify(columns));
		expect(states.get('substitutions.json')?.val).to.equal(JSON.stringify([record]));
		expect(states.get(`${channelId}.subject`)?.val).to.equal('Mathematics');
		expect(states.get(`${channelId}.subject_2`)?.val).to.equal('English');
		expect(states.get(`${channelId}.subject_3`)?.val).to.equal('History');
		expect(states.get(`${channelId}.column_04`)?.val).to.equal('');
		for (const [id, name] of [
			['subject', 'Subject'],
			['subject_2', 'Subject!'],
			['subject_3', 'Subject'],
			['column_04', 'Column 4'],
		] as const) {
			expect(objects.get(`${channelId}.${id}`)?.common).to.include({
				name,
				type: 'string',
				role: 'text',
				read: true,
				write: false,
			});
		}
	});

	it('migrates only tracked substitution fields after a complete response and retains custom names', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const columns = [
			{ header: 'Stunde', value: '03' },
			{ header: 'Unbekannte Spalte', value: 'Unverändert' },
		];
		const record = jsonRecord('migration', { portalDate: '12.11.2026', columns });
		const channelId = 'substitutions.2026-11-12.portal-record';
		const legacyFields = [
			['stunde', 'Stunde', 'Mein Zeitfenster'],
			['unbekannte_spalte', 'Unbekannte Spalte', 'Unbekannte Spalte'],
			['untracked', 'Untracked', 'Untracked'],
		];
		objects.set(channelId, {
			_id: channelId,
			type: 'channel',
			common: { name: 'Custom substitution' },
			native: { portalRecordDisplayName: 'Portal record', portalRecordFieldIds: ['stunde', 'unbekannte_spalte'] },
		});
		for (const [field, generated, name] of legacyFields) {
			const id = `${channelId}.${field}`;
			objects.set(id, {
				_id: id,
				type: 'state',
				common: { name },
				native: { portalRecordFieldDisplayName: generated },
			});
			states.set(id, state(name));
		}
		const read = (): Promise<PortalResponse> =>
			Promise.resolve({
				status: 200,
				classification: 'success',
				contentType: 'application/json',
				body: Buffer.from('[]'),
			});

		const incomplete = await adapter.refreshResource('substitutions', read, () => ({
			status: 'invalid',
			kind: 'substitutions',
			reason: 'unexpected-html-structure',
		}));
		expect(incomplete.success).to.equal(false);
		expect(states.has(`${channelId}.stunde`)).to.equal(true);
		expect(states.has(`${channelId}.unbekannte_spalte`)).to.equal(true);
		expect(states.has(`${channelId}.period`)).to.equal(false);

		const complete = await adapter.refreshResource('substitutions', read, () => ({
			status: 'complete',
			kind: 'substitutions',
			records: [record],
			groups: [],
		}));
		expect(complete.success).to.equal(true);
		expect(objects.get(channelId)?.common.name).to.equal('Custom substitution');
		expect(objects.get(`${channelId}.period`)?.common.name).to.equal('Mein Zeitfenster');
		expect(states.get(`${channelId}.period`)?.val).to.equal('03');
		expect(objects.get(`${channelId}.column_02`)?.common.name).to.equal('Column 2');
		expect(states.get(`${channelId}.column_02`)?.val).to.equal('Unverändert');
		expect(states.get(`${channelId}.columns`)?.val).to.equal(JSON.stringify(columns));
		expect(objects.has(`${channelId}.stunde`)).to.equal(false);
		expect(objects.has(`${channelId}.unbekannte_spalte`)).to.equal(false);
		expect(objects.has(`${channelId}.untracked`)).to.equal(true);
	});

	it('publishes read-only daily substitution JSON grouped by verified portal date', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const records = [
			jsonRecord('daily-1', {
				portalDate: '12.11.2026',
				columns: [
					{ header: '', value: 'must be omitted' },
					{ header: 'Hinweis', value: '' },
					{ header: 'Raum', value: 'B12' },
					{ header: 'Fach', value: 'Mathematics' },
					{ header: 'Lehrkraft', value: 'Teacher' },
					{ header: 'Vertretung', value: 'Cover teacher' },
					{ header: 'Klasse', value: '10A' },
					{ header: 'Stunde', value: '2' },
				],
			}),
			jsonRecord('daily-2', {
				portalDate: '13.11.2026',
				columns: [
					{ header: 'Stunde', value: '3' },
					{ header: 'Klasse', value: '9B' },
					{ header: 'Vertretung', value: 'Room change' },
					{ header: 'Fach', value: 'Physics' },
					{ header: 'Raum', value: 'C4' },
				],
			}),
			jsonRecord('daily-unknown-date', { columns: [{ header: 'Fach', value: 'Unassigned' }] }),
			jsonRecord('daily-invalid-date', {
				portalDate: '31.02.2026',
				columns: [{ header: 'Fach', value: 'Invalid date' }],
			}),
			jsonRecord('daily-1-second-row', {
				portalDate: '12.11.2026',
				columns: [{ header: 'Hinweis', value: 'Raum bleibt unverändert' }],
			}),
		];
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};

		const result = await adapter.refreshResource(
			'substitutions',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'substitutions', records, groups: [] }),
		);

		expect(result.success).to.equal(true);
		expect(states.get('substitutions.2026-11-12.json')?.val).to.equal(
			'[{"period":"2","class":"10A","substitution":"Cover teacher","teacher":"Teacher","subject":"Mathematics","room":"B12","note":""},' +
				'{"period":"","class":"","substitution":"","teacher":"","subject":"","room":"","note":"Raum bleibt unverändert"}]',
		);
		expect(states.get('substitutions.2026-11-13.json')?.val).to.equal(
			'[{"period":"3","class":"9B","substitution":"Room change","teacher":"","subject":"Physics","room":"C4","note":""}]',
		);
		expect(states.get('substitutions.json')?.val).to.equal(JSON.stringify(records));
		expect(states.get('substitutions.dailyJsonDates')?.val).to.equal('["2026-11-12","2026-11-13"]');
		expect(objects.get('substitutions.2026-11-12')?.type).to.equal('channel');
		const firstSourceId = createHash('sha256').update(records[0].id).digest('hex');
		const secondSourceId = createHash('sha256').update(records[1].id).digest('hex');
		const unknownSourceId = createHash('sha256').update(records[2].id).digest('hex');
		const invalidSourceId = createHash('sha256').update(records[3].id).digest('hex');
		const firstRecordPath = readableRecordPath(states, 'substitutions', firstSourceId);
		const secondRecordPath = readableRecordPath(states, 'substitutions', secondSourceId);
		const unknownRecordPath = readableRecordPath(states, 'substitutions', unknownSourceId);
		const invalidRecordPath = readableRecordPath(states, 'substitutions', invalidSourceId);
		expect(firstRecordPath).to.match(/^2026-11-12\.portal-record(?:-\d+)?$/u);
		expect(secondRecordPath).to.match(/^2026-11-13\.portal-record(?:-\d+)?$/u);
		expect(unknownRecordPath).to.match(/^undated\.portal-record(?:-\d+)?$/u);
		expect(invalidRecordPath).to.match(/^undated\.portal-record(?:-\d+)?$/u);
		expect(objects.has(`substitutions.${firstRecordPath}`)).to.equal(true);
		expect(states.get(`substitutions.${firstRecordPath}.portaldate`)?.val).to.equal('12.11.2026');
		expect(states.get(`substitutions.${firstRecordPath}.period`)?.val).to.equal('2');
		expect(states.get(`substitutions.${secondRecordPath}.portaldate`)?.val).to.equal('13.11.2026');
		expect(states.get(`substitutions.${unknownRecordPath}.subject`)?.val).to.equal('Unassigned');
		expect(states.get(`substitutions.${invalidRecordPath}.subject`)?.val).to.equal('Invalid date');
		for (const date of ['2026-11-12', '2026-11-13']) {
			expect(objects.get(`substitutions.${date}.json`)?.common).to.include({
				type: 'string',
				role: 'json',
				read: true,
				write: false,
			});
		}
		expect(objects.has('substitutions.unknown-date.json')).to.equal(false);
		expect(objects.has('substitutions.2026-02-31')).to.equal(false);
	});

	it('preserves daily substitution states on incomplete refreshes and removes stale tracked dates only after completion', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const firstRecords = [
			jsonRecord('first-date', { portalDate: '12.11.2026', columns: [{ header: 'Stunde', value: '1' }] }),
			jsonRecord('second-date', { portalDate: '13.11.2026', columns: [{ header: 'Stunde', value: '2' }] }),
		];
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};
		const complete = (records: readonly PortalRecord[]): ReturnType<TestAdapter['refreshResource']> =>
			adapter.refreshResource(
				'substitutions',
				() => Promise.resolve(response),
				() => ({ status: 'complete', kind: 'substitutions', records, groups: [] }),
			);

		await complete(firstRecords);
		const firstDateJson = states.get('substitutions.2026-11-12.json')?.val;
		const secondDateJson = states.get('substitutions.2026-11-13.json')?.val;
		const trackedDates = states.get('substitutions.dailyJsonDates')?.val;
		const firstRecordPath = readableRecordPath(
			states,
			'substitutions',
			createHash('sha256').update(firstRecords[0].id).digest('hex'),
		);
		const secondRecordPath = readableRecordPath(
			states,
			'substitutions',
			createHash('sha256').update(firstRecords[1].id).digest('hex'),
		);
		const firstRecordChannel = `substitutions.${firstRecordPath}`;
		const secondRecordChannel = `substitutions.${secondRecordPath}`;
		const incompleteResponse: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html',
			body: Buffer.from('<html></html>'),
		};
		const incomplete = await adapter.refreshResource(
			'substitutions',
			() => Promise.resolve(incompleteResponse),
			() => ({ status: 'invalid', kind: 'substitutions', reason: 'unexpected-html-structure' }),
		);
		const failed = await adapter.refreshResource('substitutions', () =>
			Promise.resolve({
				status: 503,
				classification: 'server-error',
				contentType: 'text/html',
				body: Buffer.from('unavailable'),
			}),
		);

		expect(incomplete.success).to.equal(false);
		expect(failed.success).to.equal(false);
		expect(states.get('substitutions.2026-11-12.json')?.val).to.equal(firstDateJson);
		expect(states.get('substitutions.2026-11-13.json')?.val).to.equal(secondDateJson);
		expect(states.get('substitutions.dailyJsonDates')?.val).to.equal(trackedDates);
		expect(objects.has('substitutions.2026-11-12')).to.equal(true);
		expect(objects.has('substitutions.2026-11-13')).to.equal(true);
		expect(objects.has(firstRecordChannel)).to.equal(true);
		expect(objects.has(secondRecordChannel)).to.equal(true);

		const paths = JSON.parse(String(states.get('substitutions.recordPaths')?.val)) as Record<string, string[]>;
		paths['legacy-fixed-paths'] = ['2026-11-12', '2026-11-12.json', `${firstRecordPath}.period`];
		states.set('substitutions.recordPaths', state(JSON.stringify(paths)));
		await complete([firstRecords[0]]);
		expect(states.get('substitutions.2026-11-12.json')?.val).to.equal(firstDateJson);
		expect(states.get(`${firstRecordChannel}.period`)?.val).to.equal('1');
		expect(readableRecordPath(states, 'substitutions', 'legacy-fixed-paths')).to.equal('');
		expect(states.has('substitutions.2026-11-13.json')).to.equal(false);
		expect(objects.has('substitutions.2026-11-13')).to.equal(false);
		expect(objects.has(firstRecordChannel)).to.equal(true);
		expect(objects.has(secondRecordChannel)).to.equal(false);
		expect(states.get('substitutions.dailyJsonDates')?.val).to.equal('["2026-11-12"]');
	});

	it('keeps legacy root-level substitution records on failed refreshes and migrates them after a complete refresh', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const record = jsonRecord('legacy-substitution', {
			portalDate: '12.11.2026',
			columns: [{ header: 'Fach', value: 'Mathematics' }],
		});
		const sourceId = createHash('sha256').update(record.id).digest('hex');
		const legacyChannel = 'substitutions.legacy-record';
		objects.set(legacyChannel, {
			_id: legacyChannel,
			type: 'channel',
			common: { name: 'My customized row' },
			native: { portalRecordDisplayName: 'Generated row', portalRecordFieldIds: ['fach'] },
		});
		objects.set(`${legacyChannel}.subject`, {
			_id: `${legacyChannel}.subject`,
			type: 'state',
			common: { name: 'Fach', type: 'string', role: 'text', read: true, write: false },
			native: { portalRecordFieldDisplayName: 'Fach' },
		});
		states.set(`${legacyChannel}.subject`, state('Mathematics'));
		states.set('substitutions.json', state('[{"id":"previous"}]'));
		states.set('substitutions.recordIds', state(JSON.stringify([sourceId])));
		states.set('substitutions.recordPaths', state(JSON.stringify({ [sourceId]: ['legacy-record'] })));

		const incompleteResponse: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html',
			body: Buffer.from('<html></html>'),
		};
		const incomplete = await adapter.refreshResource(
			'substitutions',
			() => Promise.resolve(incompleteResponse),
			() => ({ status: 'invalid', kind: 'substitutions', reason: 'unexpected-html-structure' }),
		);
		const failed = await adapter.refreshResource('substitutions', () =>
			Promise.resolve({
				status: 503,
				classification: 'server-error',
				contentType: 'text/html',
				body: Buffer.from('unavailable'),
			}),
		);

		expect(incomplete.success).to.equal(false);
		expect(failed.success).to.equal(false);
		expect(objects.has(legacyChannel)).to.equal(true);
		expect(states.get(`${legacyChannel}.subject`)?.val).to.equal('Mathematics');
		expect(objects.has('substitutions.2026-11-12.portal-record')).to.equal(false);

		const originalSetState = adapter.setStateAsync;
		adapter.setStateAsync = (id, value) =>
			id === 'substitutions.dailyJsonDates'
				? Promise.reject(new Error('simulated daily manifest write failure'))
				: originalSetState(id, value);
		const failedCommit = await adapter.refreshResource(
			'substitutions',
			() =>
				Promise.resolve({
					status: 200,
					classification: 'success',
					contentType: 'application/json',
					body: Buffer.from('[]'),
				}),
			() => ({ status: 'complete', kind: 'substitutions', records: [record], groups: [] }),
		);
		adapter.setStateAsync = originalSetState;
		expect(failedCommit.success).to.equal(false);
		expect(objects.has(legacyChannel)).to.equal(true);
		expect(states.get(`${legacyChannel}.subject`)?.val).to.equal('Mathematics');
		expect(states.get('substitutions.json')?.val).to.equal('[{"id":"previous"}]');

		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};
		const complete = await adapter.refreshResource(
			'substitutions',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'substitutions', records: [record], groups: [] }),
		);
		const migratedChannel = 'substitutions.2026-11-12.portal-record';

		expect(complete.success).to.equal(true);
		expect(objects.has(legacyChannel)).to.equal(false);
		expect(objects.get(migratedChannel)?.common.name).to.equal('My customized row');
		expect(states.get(`${migratedChannel}.subject`)?.val).to.equal('Mathematics');
		expect(states.get('substitutions.2026-11-12.json')?.val).to.equal(
			'[{"period":"","class":"","substitution":"","teacher":"","subject":"Mathematics","room":"","note":""}]',
		);
		expect(states.get('substitutions.json')?.val).to.equal(JSON.stringify([record]));
	});

	it('does not split JSON columns for other record resources', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const columns = [{ header: 'Subject', value: 'Mathematics' }];
		const record = jsonRecord('learning-group', { name: 'Group', columns });
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};

		const result = await adapter.refreshResource(
			'learning-groups',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'learning-groups', records: [record], groups: [] }),
		);

		expect(result.success).to.equal(true);
		const sourceId = createHash('sha256').update(record.id).digest('hex');
		const channelId = `learningGroups.${readableRecordPath(states, 'learningGroups', sourceId)}`;
		expect(states.get(`${channelId}.columns`)?.val).to.equal(JSON.stringify(columns));
		expect(objects.has(`${channelId}.subject`)).to.equal(false);
	});
});

describe('inbox header categorization', () => {
	it('splits verified unread flags into read and unread channels', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		await adapter.createObjectTree();
		const records = [
			jsonRecord('read', { id: 'hash-read', subject: 'Read subject', unread: false }),
			jsonRecord('unread', { id: 'hash-unread', subject: 'Unread subject', unread: true }),
			jsonRecord('hidden-unread', { id: 'hash-hidden', subject: 'Hidden subject', unread: true, hidden: true }),
			jsonRecord('unknown', { id: 'hash-unknown', subject: 'Unknown subject' }),
		];
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('[]'),
		};

		const result = await adapter.refreshResource(
			'messages',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'messages',
				records,
				groups: [],
			}),
		);

		expect(result.success).to.equal(true);
		expect(states.get('inbox.count')?.val).to.equal(4);
		expect(states.get('inbox.unreadCount')?.val).to.equal(1);
		expect(states.get('inbox.read.count')?.val).to.equal(1);
		expect(states.get('inbox.unread.count')?.val).to.equal(2);
		expect(states.get('inbox.read.json')?.val).to.contain('Read subject');
		expect(states.get('inbox.unread.json')?.val).to.contain('Unread subject');
		expect(states.get('inbox.unread.json')?.val).not.to.contain('content');
		expect(objects.has('inbox.recordPaths')).to.equal(false);
		expect(objects.has('inbox.read')).to.equal(true);
		expect(objects.has('inbox.unread')).to.equal(true);
	});

	it('preserves the last complete inbox when a detail aggregation fails', async () => {
		const { adapter, states } = makeTestAdapter();
		await adapter.createObjectTree();
		states.set('inbox.json', { val: '[{"id":"previous"}]', ack: true } as ioBroker.State);
		states.set('inbox.count', { val: 1, ack: true } as ioBroker.State);
		states.set('inbox.unreadCount', { val: 1, ack: true } as ioBroker.State);
		const incomplete: PortalResponse = {
			status: 200,
			classification: 'unknown',
			contentType: 'application/json',
			body: new Uint8Array(),
			diagnosticCode: 'message-detail-invalid',
		};

		const result = await adapter.refreshResource('messages', () => Promise.resolve(incomplete));

		expect(result.success).to.equal(false);
		expect(states.get('inbox.json')?.val).to.equal('[{"id":"previous"}]');
		expect(states.get('inbox.count')?.val).to.equal(1);
		expect(states.get('inbox.unreadCount')?.val).to.equal(1);
	});
});

describe('parent child lesson object synchronization', () => {
	it('updates generated labels, preserves custom names, and removes stale channels after a complete result', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const activeChildId = 'a'.repeat(64);
		const staleChildId = 'c'.repeat(64);
		const childrenBase = 'students';
		const legacyActiveChildBase = `${childrenBase}.${activeChildId}`;
		const activeChildBase = readableChildBase(activeChildId, 'Updated portal label');
		const staleChildBase = `${childrenBase}.${staleChildId}`;
		objects.set(legacyActiveChildBase, {
			_id: activeChildBase,
			type: 'channel',
			common: { name: 'Previous portal label' },
			native: { portalChildDisplayName: 'Previous portal label' },
		});
		objects.set(staleChildBase, {
			_id: staleChildBase,
			type: 'channel',
			common: { name: 'Stale child' },
			native: {},
		});
		const legacyRecordsBase = `${legacyActiveChildBase}.lessons.records`;
		objects.set(legacyRecordsBase, {
			_id: legacyRecordsBase,
			type: 'channel',
			common: { name: 'Legacy records' },
			native: {},
		});
		objects.set(`${legacyRecordsBase}.legacy`, {
			_id: `${legacyRecordsBase}.legacy`,
			type: 'state',
			common: { name: 'Legacy record' },
			native: {},
		});
		const staleSectionBase = `${legacyActiveChildBase}.lessons.exams`;
		objects.set(staleSectionBase, {
			_id: staleSectionBase,
			type: 'channel',
			common: { name: 'Stale exams' },
			native: {},
		});
		states.set(`${activeChildBase}.lessons.sectionIds`, state(JSON.stringify(['exams'])));
		states.set(`${childrenBase}.recordIds`, state(JSON.stringify([activeChildId, staleChildId])));

		await adapter.commitChildLessons([child(activeChildId, 'Updated portal label')]);

		expect(objects.get(activeChildBase)?.common.name).to.equal('Updated portal label');
		expect(objects.get(activeChildBase)?.native.portalChildDisplayName).to.equal('Updated portal label');
		expect(objects.has(staleChildBase)).to.equal(false);
		expect(objects.has(staleSectionBase)).to.equal(false);
		expect(objects.has(legacyRecordsBase)).to.equal(false);
		expect(objects.has(`${legacyRecordsBase}.legacy`)).to.equal(false);
		expect(states.get(`${activeChildBase}.lessons.count`)?.val).to.equal(1);
		expect(states.get(`${activeChildBase}.lessons.json`)?.val).to.be.a('string');
		expect(JSON.parse(String(states.get(`${childrenBase}.recordIds`)?.val))).to.deep.equal([activeChildId]);

		const activeObject = objects.get(activeChildBase);
		if (activeObject) {
			activeObject.common.name = 'User-customized label';
		}
		const renamedChildBase = readableChildBase(activeChildId, 'Renamed portal label');
		await adapter.commitChildLessons([child(activeChildId, 'Renamed portal label')]);
		expect(objects.get(renamedChildBase)?.common.name).to.equal('User-customized label');
		expect(objects.get(renamedChildBase)?.native.portalChildDisplayName).to.equal('Renamed portal label');
		expect(objects.has(activeChildBase)).to.equal(false);
	});

	it('assigns readable, collision-resolved paths to duplicate student and record names independent of input order', async () => {
		const firstId = 'b'.repeat(64);
		const secondId = 'a'.repeat(64);
		const first = childWithRecords(firstId, 'Same Student', [
			lessonRecord('c', firstId, 'current'),
			lessonRecord('d', firstId, 'current'),
		]);
		const second = childWithRecords(secondId, 'Same Student', [lessonRecord('e', secondId, 'current')]);
		const firstRun = makeTestAdapter();
		const secondRun = makeTestAdapter();

		await firstRun.adapter.commitChildLessons([first, second]);
		await secondRun.adapter.commitChildLessons([second, first]);

		const pathMapping = JSON.parse(String(firstRun.states.get('students.pathMapping')?.val)) as Record<
			string,
			string
		>;
		const reversedMapping = JSON.parse(String(secondRun.states.get('students.pathMapping')?.val)) as Record<
			string,
			string
		>;
		expect(pathMapping[secondId]).to.equal('same-student');
		expect(pathMapping[firstId]).to.equal('same-student-2');
		expect(pathMapping).to.deep.equal(reversedMapping);
		expect(firstRun.objects.has('students.same-student')).to.equal(true);
		expect(firstRun.objects.has('students.same-student-2')).to.equal(true);
		expect(firstRun.states.get('students.same-student-2.info.id')?.val).to.equal('same-student-2');
		expect(firstRun.states.get('students.same-student-2.info.name')?.val).to.equal('Same Student');

		const lessonsBase = 'students.same-student-2.lessons';
		const recordIds = JSON.parse(String(firstRun.states.get(`${lessonsBase}.recordIds`)?.val)) as string[];
		const recordPaths = recordIds.map(id => readableRecordPath(firstRun.states, lessonsBase, id)).sort();
		expect(recordPaths).to.deep.equal(['current-2', 'current-3']);
	});

	it('organizes verified student sections without mixing children or cloning the account timetable', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const firstId = 'a'.repeat(64);
		const secondId = 'c'.repeat(64);
		const first = childWithRecords(
			firstId,
			'Student Alpha',
			[
				lessonRecord('b', firstId, 'child-lessons', 'current'),
				lessonRecord('d', firstId, 'child-lessons', 'attendance'),
				lessonRecord('e', firstId, 'marks'),
				lessonRecord('f', firstId, 'child-lessons', 'other'),
			],
			['current', 'attendance'],
		);
		const second = childWithRecords(
			secondId,
			'Student Beta',
			[lessonRecord('7', secondId, 'child-lessons', 'current')],
			['current'],
		);

		await adapter.commitChildLessons([first, second]);

		const firstBase = readableChildBase(firstId, 'Student Alpha');
		const secondBase = readableChildBase(secondId, 'Student Beta');
		expect(states.get(`${firstBase}.info.status`)?.val).to.equal('complete');
		expect(states.get(`${firstBase}.info.lastUpdate`)?.val)
			.to.be.a('number')
			.and.greaterThan(0);
		expect(states.get(`${firstBase}.timetable.status`)?.val).to.equal('not-updated');
		expect(objects.has(`${firstBase}.timetable.records`)).to.equal(false);
		expect(states.get(`${firstBase}.lessons.count`)?.val).to.equal(4);
		expect(states.get(`${firstBase}.lessons.current.count`)?.val).to.equal(1);
		expect(states.get(`${firstBase}.lessons.attendance.count`)?.val).to.equal(1);
		expect(
			JSON.parse(String(states.get(`${firstBase}.lessons.current.json`)?.val)).map(
				(record: PortalRecord) => record.context?.childId,
			),
		).to.deep.equal([firstId]);
		expect(states.get(`${firstBase}.lessons.marks.count`)?.val).to.equal(1);
		expect(states.get(`${firstBase}.lessons.other.count`)?.val).to.equal(1);
		expect(objects.has(`${firstBase}.lessons.assignments`)).to.equal(false);
		expect(states.get(`${secondBase}.lessons.count`)?.val).to.equal(1);
		expect(states.get(`${secondBase}.lessons.current.count`)?.val).to.equal(1);
		expect(
			JSON.parse(String(states.get(`${secondBase}.lessons.current.json`)?.val)).map(
				(record: PortalRecord) => record.context?.childId,
			),
		).to.deep.equal([secondId]);
		expect(objects.has(`${secondBase}.lessons.attendance`)).to.equal(false);
		expect(JSON.parse(String(states.get(`${firstBase}.lessons.sectionIds`)?.val))).to.deep.equal([
			'attendance',
			'current',
			'marks',
			'other',
		]);
	});

	it('creates a confirmed empty lesson section without treating an absent section as empty', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [], ['current'])]);

		const childBase = readableChildBase(childId, 'Student');
		expect(states.get(`${childBase}.lessons.status`)?.val).to.equal('complete');
		expect(states.get(`${childBase}.lessons.count`)?.val).to.equal(0);
		expect(states.get(`${childBase}.lessons.current.status`)?.val).to.equal('complete');
		expect(states.get(`${childBase}.lessons.current.count`)?.val).to.equal(0);
		expect(states.get(`${childBase}.timetable.status`)?.val).to.equal('not-updated');
		expect(objects.has(`${childBase}.lessons.assignments`)).to.equal(false);
	});

	it('uses a concise name for the combined lesson details field and retains generic attendance columns without headers', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		const combinedHeader = 'Thema Datum\nInhalt (wenn hinterlegt)\nHausaufgaben (wenn hinterlegt)';
		const current = htmlLessonRecord('b', childId, [
			{ header: 'Name', text: 'Synthetic lesson name' },
			{ header: combinedHeader, text: 'Synthetic combined details' },
			{ header: 'Weiteres', text: 'Synthetic note' },
		]);
		const attendance = htmlLessonRecord('c', childId, [
			{ header: null, text: 'Synthetic attendance field' },
			{ header: null, text: 'Synthetic attendance field two' },
		]);
		current.section = 'current';
		attendance.section = 'attendanceTable';
		await adapter.commitChildLessons([
			childWithRecords(childId, 'Student', [current, attendance], ['current', 'attendance']),
		]);

		const lessonsBase = `${readableChildBase(childId, 'Student')}.lessons`;
		const currentBase = `${lessonsBase}.current`;
		const currentId = JSON.parse(String(states.get(`${currentBase}.recordIds`)?.val))[0] as string;
		const currentRecordBase = `${currentBase}.${readableRecordPath(states, currentBase, currentId)}`;
		const combinedFieldId = `${currentRecordBase}.lesson_details`;
		expect(objects.get(`${currentRecordBase}.name`)?.common.name).to.equal('Name');
		expect(objects.get(combinedFieldId)?.common.name).to.equal('Lesson details');
		expect(states.get(combinedFieldId)?.val).to.equal('Synthetic combined details');
		expect(objects.get(`${currentRecordBase}.additional_information`)?.common.name).to.equal(
			'Additional information',
		);
		const aggregate = JSON.parse(String(states.get(`${lessonsBase}.json`)?.val)) as Array<{
			fields?: Array<{ header: string | null; text: string }>;
		}>;
		expect(aggregate[0]?.fields?.[1]).to.deep.equal({
			header: combinedHeader,
			text: 'Synthetic combined details',
			links: [],
			attributes: {},
		});

		const attendanceBase = `${lessonsBase}.attendance`;
		const attendanceId = JSON.parse(String(states.get(`${attendanceBase}.recordIds`)?.val))[0] as string;
		const attendanceRecordBase = `${attendanceBase}.${readableRecordPath(states, attendanceBase, attendanceId)}`;
		expect(objects.get(`${attendanceRecordBase}.column_01`)?.common.name).to.equal('Column 1');
		expect(states.get(`${attendanceRecordBase}.column_01`)?.val).to.equal('Synthetic attendance field');
		expect(objects.get(`${attendanceRecordBase}.column_02`)?.common.name).to.equal('Column 2');
	});

	it('creates direct record channels with stable field states and deterministic duplicate or missing header IDs', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		const record = htmlLessonRecord('b', childId, [
			{ header: 'Course Name', text: 'Mathematics' },
			{ header: 'Course Name', text: 'Science' },
			{ header: null, text: 'Visible without a header' },
		]);

		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [record])]);

		const lessonsBase = `${readableChildBase(childId, 'Student')}.lessons`;
		const recordId = JSON.parse(String(states.get(`${lessonsBase}.recordIds`)?.val))[0] as string;
		const recordBase = `${lessonsBase}.${readableRecordPath(states, lessonsBase, recordId)}`;
		expect(objects.get(recordBase)?.type).to.equal('channel');
		expect(objects.has(`${lessonsBase}.records`)).to.equal(false);
		for (const field of [
			['course_name', 'Course Name', 'Mathematics'],
			['course_name_2', 'Course Name', 'Science'],
			['column_03', 'Column 3', 'Visible without a header'],
		] as const) {
			const [fieldId, name, value] = field;
			const id = `${recordBase}.${fieldId}`;
			expect(objects.get(id)?.common.name).to.equal(name);
			expect(objects.get(id)?.common.read).to.equal(true);
			expect(objects.get(id)?.common.write).to.equal(false);
			expect(states.get(id)?.val).to.equal(value);
			expect(states.get(id)?.ack).to.equal(true);
		}
		const recordObject = objects.get(recordBase);
		if (recordObject) {
			recordObject.common.name = 'Custom row label';
		}
		await adapter.commitChildLessons([
			childWithRecords(childId, 'Student', [
				htmlLessonRecord('b', childId, [
					{ header: 'Course Name', text: 'Updated Mathematics' },
					{ header: 'Course Name', text: 'Updated Science' },
					{ header: null, text: 'Updated unlabeled value' },
				]),
			]),
		]);
		const updatedRecordBase = `${lessonsBase}.${readableRecordPath(states, lessonsBase, recordId)}`;
		expect(objects.get(updatedRecordBase)?.common.name).to.equal('Custom row label');
		expect(objects.has(recordBase)).to.equal(false);
	});

	it('writes readable records before cleaning legacy paths and preserves customized legacy names', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		const record = htmlLessonRecord('b', childId, [{ header: 'Subject', text: 'Mathematics' }]);
		const recordId = createHash('sha256').update(record.id).digest('hex');
		const lessonsBase = `${readableChildBase(childId, 'Student')}.lessons`;
		const legacyRecordBase = `${lessonsBase}.${recordId}`;
		const legacyRecordsBase = `${lessonsBase}.records`;
		objects.set(legacyRecordBase, {
			_id: legacyRecordBase,
			type: 'channel',
			common: { name: 'My customized lesson' },
			native: { portalRecordDisplayName: 'Current — Mathematics', portalRecordFieldIds: [] },
		});
		objects.set(legacyRecordsBase, {
			_id: legacyRecordsBase,
			type: 'channel',
			common: { name: 'Legacy records' },
			native: {},
		});
		objects.set(`${legacyRecordsBase}.${recordId}`, {
			_id: `${legacyRecordsBase}.${recordId}`,
			type: 'channel',
			common: { name: 'Legacy nested record' },
			native: {},
		});
		states.set(`${lessonsBase}.recordIds`, state(JSON.stringify([recordId])));

		const originalDelete = adapter.delObjectAsync.bind(adapter);
		adapter.delObjectAsync = (id, options) => {
			if (id === legacyRecordBase || id === `${lessonsBase}.records`) {
				const readableBase = `${lessonsBase}.current-mathematics`;
				expect(objects.get(readableBase)?.type).to.equal('channel');
				expect(states.get(`${readableBase}.subject`)?.val).to.equal('Mathematics');
			}
			return originalDelete(id, options);
		};

		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [record])]);

		const readableBase = `${lessonsBase}.${readableRecordPath(states, lessonsBase, recordId)}`;
		expect(objects.get(readableBase)?.common.name).to.equal('My customized lesson');
		expect(objects.has(legacyRecordBase)).to.equal(false);
		expect(objects.has(legacyRecordsBase)).to.equal(false);
	});

	it('exposes JSON scalars with their values and nested properties as JSON strings', async () => {
		const { adapter, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		const record = jsonLessonRecord('c', childId, {
			title: 'Assessment',
			points: 0,
			passed: false,
			details: { room: 'A1' },
		});

		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [record])]);

		const lessonsBase = `${readableChildBase(childId, 'Student')}.lessons`;
		const recordId = JSON.parse(String(states.get(`${lessonsBase}.recordIds`)?.val))[0] as string;
		const recordBase = `${lessonsBase}.${readableRecordPath(states, lessonsBase, recordId)}`;
		expect(states.get(`${recordBase}.title`)?.val).to.equal('Assessment');
		expect(states.get(`${recordBase}.points`)?.val).to.equal(0);
		expect(states.get(`${recordBase}.passed`)?.val).to.equal(false);
		expect(states.get(`${recordBase}.details`)?.val).to.equal('{"room":"A1"}');
	});

	it('keeps child channels when a complete lesson response has no verified parent-child structure', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const firstChildId = 'a'.repeat(64);
		const secondChildId = 'c'.repeat(64);
		const childIds = JSON.stringify([firstChildId, secondChildId]);
		for (const [id, name] of [
			[firstChildId, 'First child'],
			[secondChildId, 'Second child'],
		] as const) {
			const childBase = `students.${id}`;
			objects.set(childBase, {
				_id: childBase,
				type: 'channel',
				common: { name },
				native: {},
			});
		}
		states.set('students.recordIds', state(childIds));
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html',
			body: Buffer.from('<html></html>'),
		};

		const result = await adapter.refreshResource(
			'lessons',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'lessons',
				records: [],
				groups: [],
			}),
		);

		expect(result.success).to.equal(true);
		expect(objects.has(`students.${firstChildId}`)).to.equal(true);
		expect(objects.has(`students.${secondChildId}`)).to.equal(true);
		expect(states.get('students.recordIds')?.val).to.equal(childIds);
	});

	it('does not alter existing child objects when the lesson response is incomplete', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		const staleChildId = 'c'.repeat(64);
		const childBase = `students.${childId}`;
		const staleChildBase = `students.${staleChildId}`;
		const previousJson = '[{"id":"existing"}]';
		objects.set(childBase, {
			_id: childBase,
			type: 'channel',
			common: { name: 'Existing child' },
			native: {},
		});
		objects.set(staleChildBase, {
			_id: staleChildBase,
			type: 'channel',
			common: { name: 'Possibly stale child' },
			native: {},
		});
		const childLessonsBase = `${childBase}.lessons`;
		const legacyRecordsBase = `${childLessonsBase}.records`;
		const sourceRecordId = createHash('sha256').update('legacy-lesson').digest('hex');
		const legacyRecordPath = `${childLessonsBase}.legacy-lesson`;
		objects.set(legacyRecordsBase, {
			_id: legacyRecordsBase,
			type: 'channel',
			common: { name: 'Legacy records' },
			native: {},
		});
		objects.set(legacyRecordPath, {
			_id: legacyRecordPath,
			type: 'channel',
			common: { name: 'Existing lesson record' },
			native: {},
		});
		states.set('students.recordIds', state(JSON.stringify([childId, staleChildId])));
		states.set(`${childLessonsBase}.recordIds`, state(JSON.stringify([sourceRecordId])));
		states.set(`${childLessonsBase}.recordPaths`, state(JSON.stringify({ [sourceRecordId]: ['legacy-lesson'] })));
		states.set(`${legacyRecordPath}.subject`, state('Previously confirmed'));
		states.set(`${childLessonsBase}.json`, state(previousJson));
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html',
			body: Buffer.from('<html></html>'),
		};

		const result = await adapter.refreshResource(
			'lessons',
			() => Promise.resolve(response),
			() => ({ status: 'invalid', kind: 'lessons', reason: 'lessons-tabs-invalid' }),
		);

		expect(result.success).to.equal(false);
		expect(objects.has(childBase)).to.equal(true);
		expect(objects.has(staleChildBase)).to.equal(true);
		expect(states.get('students.recordIds')?.val).to.equal(JSON.stringify([childId, staleChildId]));
		expect(states.get(`${childLessonsBase}.recordIds`)?.val).to.equal(JSON.stringify([sourceRecordId]));
		expect(states.get(`${childLessonsBase}.recordPaths`)?.val).to.equal(
			JSON.stringify({ [sourceRecordId]: ['legacy-lesson'] }),
		);
		expect(states.get(`${childLessonsBase}.json`)?.val).to.equal(previousJson);
		expect(objects.has(legacyRecordPath)).to.equal(true);
		expect(states.get(`${legacyRecordPath}.subject`)?.val).to.equal('Previously confirmed');
		expect(objects.has(legacyRecordsBase)).to.equal(true);
	});
});

describe('parent child timetable object synchronization', () => {
	it('commits timetable records under readable child paths and uses verified period-based lesson channels', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		adapter.getBerlinToday = () => '2026-11-11';
		const childId = 'a'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student Alpha', [])]);
		const childBase = readableChildBase(childId, 'Student Alpha');
		const timetableBase = `${childBase}.timetable`;

		const timedFridayRecord: PortalRecord = {
			format: 'html',
			id: `timetable:${'h'.repeat(64)}`,
			section: 'own',
			attributes: {},
			fields: [
				{ header: 'Stunde', text: '5 11:25 - 12:10 5.', links: [], attributes: {} },
				{ header: 'Lesson', text: 'Chemistry', links: [], attributes: {} },
				{ header: 'Start time', text: '11:25', links: [], attributes: {} },
				{ header: 'End time', text: '12:10', links: [], attributes: {} },
			],
			context: { childId, timetableWeekday: 'friday' },
		};
		const records = [
			timetableRecord('b', childId, '2026-11-11', 'Mathematics'),
			timetableRecord('f', childId, '2026-11-11', 'Physics'),
			timetableRecord('c', childId, '2026-11-12', 'Biology'),
			timetableRecord('d', childId, '2026-11-10', 'Previous Tuesday'),
			timetableWeekdayRecord('e', childId, 'tuesday', 'Next Tuesday'),
			timetableRecord('g', childId, 'Monday', 'Next Monday'),
			timedFridayRecord,
		];
		const legacyRecordsBase = `${timetableBase}.records`;
		const legacyRecordId = createHash('sha256')
			.update(records[0]?.id ?? '')
			.digest('hex');
		objects.set(legacyRecordsBase, {
			_id: legacyRecordsBase,
			type: 'channel',
			common: { name: 'Legacy records' },
			native: {},
		});
		objects.set(`${legacyRecordsBase}.${legacyRecordId}`, {
			_id: `${legacyRecordsBase}.${legacyRecordId}`,
			type: 'state',
			common: { name: 'Custom migrated lesson' },
			native: { portalRecordDisplayName: 'Personal timetable — 2026-11-11 — Mathematics' },
		});
		const childTimetables: PortalChildTimetable[] = [{ id: childId, records }];
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('{}'),
		};

		const result = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'timetable', records, groups: [], childTimetables }),
		);

		expect(result).to.deep.equal({ success: true, degraded: false, status: 'complete' });
		expect(objects.get(timetableBase)?.type).to.equal('channel');
		expect(objects.has(`${timetableBase}.records`)).to.equal(false);
		for (const stateId of ['status', 'count', 'lastUpdate', 'json', 'recordIds']) {
			expect(states.has(`${timetableBase}.${stateId}`), `${stateId} state exists`).to.equal(true);
		}
		expect(states.get(`${timetableBase}.status`)?.val).to.equal('complete');
		expect(states.get('students.timetable.count')?.val).to.equal(0);
		expect(objects.get('students.timetable.json')?.type).to.equal('state');
		expect(states.get(`${timetableBase}.count`)?.val).to.equal(records.length);
		expect(states.get(`${timetableBase}.lastUpdate`)?.val)
			.to.be.a('number')
			.and.greaterThan(0);
		expect(JSON.parse(String(states.get(`${timetableBase}.json`)?.val))).to.deep.equal(records);

		const todayLesson = `${timetableBase}.today.lessons.lesson_01`;
		const secondTodayLesson = `${timetableBase}.today.lessons.lesson_02`;
		const tomorrowLesson = `${timetableBase}.tomorrow.lessons.lesson_01`;
		const wednesdayLesson = `${timetableBase}.week.wednesday.lessons.lesson_01`;
		const thursdayLesson = `${timetableBase}.week.thursday.lessons.lesson_01`;
		const movedTuesdayLesson = `${timetableBase}.week.tuesday.lessons.lesson_01`;
		const nextTuesdayLesson = `${timetableBase}.week.tuesday.lessons.01`;
		const nextMondayLesson = `${timetableBase}.week.monday.lessons.lesson_01`;
		const timedFridayLesson = `${timetableBase}.week.friday.lessons.05`;
		expect(states.get(`${todayLesson}.subject`)?.val).to.equal('Mathematics');
		expect(states.get(`${secondTodayLesson}.subject`)?.val).to.equal('Physics');
		expect(states.get(`${timetableBase}.today.lessons.recordIds`)?.val).to.equal('["lesson_01","lesson_02"]');
		expect(states.get(`${tomorrowLesson}.subject`)?.val).to.equal('Biology');
		expect(states.get(`${wednesdayLesson}.subject`)?.val).to.equal('Mathematics');
		expect(states.get(`${thursdayLesson}.subject`)?.val).to.equal('Biology');
		expect(states.get(`${movedTuesdayLesson}.subject`)?.val).to.equal('Previous Tuesday');
		expect(states.get(`${nextTuesdayLesson}.subject`)?.val).to.equal('Next Tuesday');
		expect(states.get(`${nextMondayLesson}.subject`)?.val).to.equal('Next Monday');
		expect(states.get(`${timedFridayLesson}.period`)?.val).to.equal('5');
		expect(states.get(`${timedFridayLesson}.lesson`)?.val).to.equal('Chemistry');
		expect(states.get(`${timedFridayLesson}.start_time`)?.val).to.equal('11:25');
		expect(states.get(`${timedFridayLesson}.end_time`)?.val).to.equal('12:10');
		expect(JSON.parse(String(states.get(`${timetableBase}.json`)?.val))).to.deep.equal(records);
		for (const [weekday, count] of [
			['monday', 1],
			['tuesday', 2],
			['wednesday', 2],
			['thursday', 1],
			['friday', 1],
			['saturday', 0],
			['sunday', 0],
		] as const) {
			expect(states.get(`${timetableBase}.week.${weekday}.lessonCount`)?.val).to.equal(count);
			expect(states.get(`${timetableBase}.week.${weekday}.hasLessons`)?.val).to.equal(count > 0);
		}
		expect(states.get(`${timetableBase}.today.lessonCount`)?.val).to.equal(2);
		expect(states.get(`${timetableBase}.tomorrow.lessonCount`)?.val).to.equal(1);
		expect(objects.get(`${timetableBase}.week.friday.lessonCount`)?.common).to.include({
			type: 'number',
			role: 'value',
			read: true,
			write: false,
		});
		expect(JSON.parse(String(states.get(`${timetableBase}.week.tuesday.lessons.recordIds`)?.val))).to.deep.equal([
			'01',
			'lesson_01',
		]);
		expect(objects.get(todayLesson)?.type).to.equal('channel');
		expect(objects.get(todayLesson)?.common.name).to.equal('Custom migrated lesson');
		expect(objects.has(`${timetableBase}.week`)).to.equal(true);
	});

	it('strips only the generic prefix from generated personal timetable lesson names', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		adapter.getBerlinToday = () => '2026-11-11';
		const childId = 'e'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student Gamma', [])]);
		const timetableBase = `${readableChildBase(childId, 'Student Gamma')}.timetable`;
		const createPersonalRecord = (id: string, period: string, lesson: string): PortalRecord => ({
			format: 'html',
			id: `timetable:${id.repeat(64)}`,
			section: 'own',
			attributes: {},
			fields: [
				{ header: 'Stunde', text: period, links: [], attributes: {} },
				{ header: 'Lesson', text: lesson, links: [], attributes: {} },
			],
			context: { childId, timetableWeekday: 'friday' },
		});
		const records = [
			createPersonalRecord('d', '2 08:35 - 09:20 2.', 'E1 2-206 WRN'),
			createPersonalRecord('f', '3 09:30 - 10:15 3.', 'Custom lesson'),
		];
		const generatedLesson = `${timetableBase}.week.friday.lessons.02`;
		const customizedLesson = `${timetableBase}.week.friday.lessons.03`;
		const previousGeneratedName = 'Personal timetable — 3 09:30 - 10:15 3. — Custom lesson';
		objects.set(customizedLesson, {
			_id: customizedLesson,
			type: 'channel',
			common: { name: 'My customized timetable lesson' },
			native: {
				portalRecordDisplayName: previousGeneratedName,
				portalRecordFieldIds: ['stunde', 'lesson'],
			},
		});
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('{}'),
		};

		const result = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'timetable',
				records,
				groups: [],
				childTimetables: [{ id: childId, records }],
			}),
		);

		expect(result.success).to.equal(true);
		expect(objects.get(generatedLesson)?.common.name).to.equal('2 08:35 - 09:20 2. — E1 2-206 WRN');
		expect(states.get(`${generatedLesson}.period`)?.val).to.equal('2');
		expect(states.get(`${generatedLesson}.lesson`)?.val).to.equal('E1 2-206 WRN');
		expect(objects.get(customizedLesson)?.common.name).to.equal('My customized timetable lesson');
		expect(states.get(`${customizedLesson}.period`)?.val).to.equal('3');
		expect(states.get(`${customizedLesson}.lesson`)?.val).to.equal('Custom lesson');
	});

	it('retains duplicate and unparseable periods without guessing a period state', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		adapter.getBerlinToday = () => '2026-11-11';
		const childId = 'c'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student Beta', [])]);
		const childBase = readableChildBase(childId, 'Student Beta');
		const timetableBase = `${childBase}.timetable`;
		const makeRecord = (id: string, period: string, lesson: string, start: string, end: string): PortalRecord => ({
			format: 'html',
			id: `timetable:${id.repeat(64)}`,
			section: 'own',
			attributes: {},
			fields: [
				{ header: 'Stunde', text: period, links: [], attributes: {} },
				{ header: 'Lesson', text: lesson, links: [], attributes: {} },
				{ header: 'Start time', text: start, links: [], attributes: {} },
				{ header: 'End time', text: end, links: [], attributes: {} },
			],
			context: { childId, timetableWeekday: 'friday' },
		});
		const records = [
			makeRecord('i', '5 11:25 - 12:10 5.', 'Chemistry', '11:25', '12:10'),
			makeRecord('j', '5 12:15 - 13:00 5.', 'Biology', '12:15', '13:00'),
			makeRecord('k', 'unknown period', 'Study hall', '13:05', '13:50'),
			makeRecord('l', '5 14:00 - 14:45 6.', 'Ambiguous period', '14:00', '14:45'),
		];
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('{}'),
		};

		const result = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'timetable',
				records: [],
				groups: [],
				childTimetables: [{ id: childId, records }],
			}),
		);

		const lessonsBase = `${timetableBase}.week.friday.lessons`;
		const firstLesson = `${lessonsBase}.05`;
		const duplicateLesson = `${lessonsBase}.05_2`;
		const unknownLesson = `${lessonsBase}.lesson_03`;
		const ambiguousLesson = `${lessonsBase}.lesson_04`;
		expect(result.success).to.equal(true);
		expect(states.get(`${lessonsBase}.recordIds`)?.val).to.equal('["05","05_2","lesson_03","lesson_04"]');
		expect(states.get(`${firstLesson}.period`)?.val).to.equal('5');
		expect(states.get(`${firstLesson}.start_time`)?.val).to.equal('11:25');
		expect(states.get(`${firstLesson}.end_time`)?.val).to.equal('12:10');
		expect(states.get(`${duplicateLesson}.period`)?.val).to.equal('5');
		expect(states.get(`${duplicateLesson}.lesson`)?.val).to.equal('Biology');
		expect(objects.has(`${unknownLesson}.period`)).to.equal(false);
		expect(states.get(`${unknownLesson}.lesson`)?.val).to.equal('Study hall');
		expect(states.get(`${unknownLesson}.start_time`)?.val).to.equal('13:05');
		expect(objects.has(`${ambiguousLesson}.period`)).to.equal(false);
		expect(states.get(`${ambiguousLesson}.lesson`)?.val).to.equal('Ambiguous period');
		expect(JSON.parse(String(states.get(`${timetableBase}.json`)?.val))).to.deep.equal(records);
	});

	it('keeps confirmed legacy child timetables until complete data is written to the readable path', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		adapter.getBerlinToday = () => '2026-11-11';
		const childId = 'a'.repeat(64);
		const legacyChildBase = `students.${childId}`;
		const legacyLessonsBase = `${legacyChildBase}.lessons`;
		const legacyTimetableBase = `${legacyChildBase}.timetable`;
		const legacyLesson = `${legacyTimetableBase}.today.lessons.01`;
		objects.set(legacyLessonsBase, {
			_id: legacyLessonsBase,
			type: 'channel',
			common: { name: 'Lessons' },
			native: {},
		});
		states.set(`${legacyLessonsBase}.json`, state('[{"id":"old-lesson"}]'));
		objects.set(legacyChildBase, {
			_id: legacyChildBase,
			type: 'channel',
			common: { name: 'Student' },
			native: { portalChildDisplayName: 'Student' },
		});
		objects.set(legacyLesson, {
			_id: legacyLesson,
			type: 'channel',
			common: { name: 'Existing confirmed lesson' },
			native: {},
		});
		states.set('students.recordIds', state(JSON.stringify([childId])));
		states.set(`${legacyTimetableBase}.status`, state('complete'));
		states.set(`${legacyTimetableBase}.count`, state(1));
		states.set(`${legacyTimetableBase}.json`, state('[{"id":"existing"}]'));
		states.set(`${legacyLesson}.subject`, state('Existing subject'));

		await adapter.commitChildLessons([childWithRecords(childId, 'Student A', [])]);

		const childBase = readableChildBase(childId, 'Student A');
		const timetableBase = `${childBase}.timetable`;
		const mapping = JSON.parse(String(states.get('students.pathMapping')?.val)) as Record<string, string>;
		const pending = JSON.parse(String(states.get('students.pendingTimetablePaths')?.val)) as Record<
			string,
			string[]
		>;
		expect(mapping[childId]).to.equal('student-a');
		expect(pending[childId]).to.deep.equal([childId]);
		expect(states.get(`${legacyTimetableBase}.json`)?.val).to.equal('[{"id":"existing"}]');
		expect(states.get(`${legacyLesson}.subject`)?.val).to.equal('Existing subject');
		expect(objects.has(legacyLessonsBase)).to.equal(false);
		expect(states.has(`${legacyLessonsBase}.json`)).to.equal(false);

		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('{}'),
		};
		const incomplete = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({ status: 'invalid', kind: 'timetable', reason: 'timetable-tables-missing' }),
		);
		expect(incomplete.success).to.equal(false);
		expect(states.get(`${legacyTimetableBase}.json`)?.val).to.equal('[{"id":"existing"}]');
		expect(states.get(`${legacyLesson}.subject`)?.val).to.equal('Existing subject');

		const records = [timetableRecord('b', childId, '2026-11-11', 'Mathematics')];
		const complete = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'timetable',
				records,
				groups: [],
				childTimetables: [{ id: childId, records }],
			}),
		);

		expect(complete.success).to.equal(true);
		expect(states.get(`${timetableBase}.today.lessons.lesson_01.subject`)?.val).to.equal('Mathematics');
		expect(states.get(`${timetableBase}.status`)?.val).to.equal('complete');
		expect(objects.has(legacyChildBase)).to.equal(false);
		expect(JSON.parse(String(states.get('students.pendingTimetablePaths')?.val))).to.deep.equal({});
	});

	it('preserves a confirmed empty legacy timetable until an empty refresh completes at the readable path', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		const legacyChildBase = `students.${childId}`;
		const legacyTimetableBase = `${legacyChildBase}.timetable`;
		objects.set(legacyChildBase, {
			_id: legacyChildBase,
			type: 'channel',
			common: { name: 'Student' },
			native: { portalChildDisplayName: 'Student' },
		});
		states.set('students.recordIds', state(JSON.stringify([childId])));
		states.set(`${legacyTimetableBase}.status`, state('complete'));
		states.set(`${legacyTimetableBase}.count`, state(0));
		states.set(`${legacyTimetableBase}.lastUpdate`, state(1_700_000_000_000));
		states.set(`${legacyTimetableBase}.json`, state('[]'));
		states.set(`${legacyTimetableBase}.recordIds`, state('[]'));

		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [])]);

		const childBase = readableChildBase(childId, 'Student');
		const timetableBase = `${childBase}.timetable`;
		const pending = JSON.parse(String(states.get('students.pendingTimetablePaths')?.val)) as Record<
			string,
			string[]
		>;
		expect(pending[childId]).to.deep.equal([childId]);
		expect(states.get(`${legacyTimetableBase}.status`)?.val).to.equal('complete');
		expect(states.get(`${legacyTimetableBase}.count`)?.val).to.equal(0);

		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('{}'),
		};
		const incomplete = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({ status: 'invalid', kind: 'timetable', reason: 'timetable-tables-missing' }),
		);
		expect(incomplete.success).to.equal(false);
		expect(states.get(`${legacyTimetableBase}.status`)?.val).to.equal('complete');

		const complete = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'timetable',
				records: [],
				groups: [],
				childTimetables: [{ id: childId, records: [] }],
			}),
		);
		expect(complete.success).to.equal(true);
		expect(states.get(`${timetableBase}.status`)?.val).to.equal('complete');
		expect(states.get(`${timetableBase}.count`)?.val).to.equal(0);
		expect(objects.has(legacyChildBase)).to.equal(false);
	});

	it('creates every summary, week-day, and lessons channel for a confirmed empty timetable', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		adapter.getBerlinToday = () => '2026-11-11';
		const childId = 'a'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [])]);
		const childBase = readableChildBase(childId, 'Student');
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('{}'),
		};
		const result = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'timetable',
				records: [],
				groups: [],
				childTimetables: [{ id: childId, records: [] }],
			}),
		);

		expect(result.success).to.equal(true);
		const timetableBase = `${childBase}.timetable`;
		for (const day of [
			'today',
			'tomorrow',
			'week.monday',
			'week.tuesday',
			'week.wednesday',
			'week.thursday',
			'week.friday',
			'week.saturday',
			'week.sunday',
		]) {
			expect(objects.get(`${timetableBase}.${day}`)?.type, `${day} channel`).to.equal('channel');
			expect(objects.get(`${timetableBase}.${day}.lessons`)?.type, `${day} lessons`).to.equal('channel');
			expect(states.get(`${timetableBase}.${day}.lessons.recordIds`)?.val).to.equal('[]');
			expect(states.get(`${timetableBase}.${day}.lessonCount`)?.val).to.equal(0);
			expect(states.get(`${timetableBase}.${day}.hasLessons`)?.val).to.equal(false);
		}
		expect(states.get(`${timetableBase}.count`)?.val).to.equal(0);
		expect(states.get(`${timetableBase}.json`)?.val).to.equal('[]');
	});

	it('creates a child timetable status without reporting unavailable data as empty', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [])]);
		const childBase = readableChildBase(childId, 'Student');
		const timetableBase = `${childBase}.timetable`;
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html',
			body: Buffer.from('<html></html>'),
		};

		const result = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({ status: 'unavailable', kind: 'timetable', reason: 'feature-unavailable' }),
		);

		expect(result.success).to.equal(false);
		expect(objects.get(timetableBase)?.type).to.equal('channel');
		expect(states.get(`${timetableBase}.status`)?.val).to.equal('feature-unavailable');
		expect(states.has(`${timetableBase}.count`)).to.equal(false);
		expect(states.has(`${timetableBase}.json`)).to.equal(false);
		expect(objects.has(`${timetableBase}.today`)).to.equal(false);
	});

	it('retains a safe child-detail failure reason in resource and child status', async () => {
		const { adapter, states } = makeTestAdapter();
		const childId = 'a'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [])]);
		const childBase = readableChildBase(childId, 'Student');
		for (const base of ['students.timetable', `${childBase}.timetable`]) {
			states.set(`${base}.status`, state('not-updated'));
			states.set(`${base}.count`, state(0));
			states.set(`${base}.lastUpdate`, state(0));
			states.set(`${base}.json`, state('[]'));
			states.set(`${base}.recordIds`, state('[]'));
		}
		const response: PortalResponse = {
			status: 200,
			classification: 'unknown',
			contentType: 'application/json',
			body: new Uint8Array(),
			diagnosticCode: 'timetable-child-own-section-missing',
		};

		const result = await adapter.refreshResource('timetable', () => Promise.resolve(response));

		expect(result.status).to.equal('unknown-response:timetable-child-own-section-missing');
		expect(states.get('students.timetable.status')?.val).to.equal(result.status);
		expect(states.get(`${childBase}.timetable.status`)?.val).to.equal(result.status);
		for (const base of ['students.timetable', `${childBase}.timetable`]) {
			for (const stateId of ['count', 'lastUpdate', 'json', 'recordIds']) {
				expect(states.has(`${base}.${stateId}`)).to.equal(false);
			}
		}
	});

	it('preserves prior timetable records when a refresh is incomplete or contains rows without date fields', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		adapter.getBerlinToday = () => '2026-11-11';
		const childId = 'a'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(childId, 'Student', [])]);
		const childBase = readableChildBase(childId, 'Student');
		const timetableBase = `${childBase}.timetable`;
		const oldLessonBase = `${timetableBase}.today.lessons.01`;
		objects.set(oldLessonBase, {
			_id: oldLessonBase,
			type: 'channel',
			common: { name: 'Existing lesson' },
			native: {},
		});
		states.set(`${timetableBase}.json`, state('[{"id":"existing"}]'));
		states.set(`${timetableBase}.count`, state(1));
		states.set(`${oldLessonBase}.subject`, state('Existing subject'));
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html',
			body: Buffer.from('<html></html>'),
		};

		const incomplete = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({ status: 'invalid', kind: 'timetable', reason: 'timetable-tables-missing' }),
		);
		expect(incomplete.success).to.equal(false);
		expect(states.get(`${timetableBase}.json`)?.val).to.equal('[{"id":"existing"}]');
		expect(states.get(`${timetableBase}.count`)?.val).to.equal(1);
		expect(states.get(`${timetableBase}.status`)?.val).to.equal('invalid-response:timetable-tables-missing');
		expect(states.get(`${oldLessonBase}.subject`)?.val).to.equal('Existing subject');

		const missingDateRecord: PortalRecord = {
			format: 'html',
			id: 'timetable:unassignable',
			section: 'own',
			attributes: {},
			fields: [{ header: 'Subject', text: 'No date', links: [], attributes: {} }],
			context: { childId },
		};
		const unassignable = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({
				status: 'complete',
				kind: 'timetable',
				records: [missingDateRecord],
				groups: [],
				childTimetables: [{ id: childId, records: [missingDateRecord] }],
			}),
		);
		expect(unassignable.success).to.equal(false);
		expect(unassignable.status).to.equal('invalid-response:unassignable-timetable-record');
		expect(states.get(`${timetableBase}.status`)?.val).to.equal('invalid-response:unassignable-timetable-record');
		expect(states.get(`${timetableBase}.json`)?.val).to.equal('[{"id":"existing"}]');
		expect(states.get(`${oldLessonBase}.subject`)?.val).to.equal('Existing subject');
		expect(objects.has(`${timetableBase}.today.lessons.01`)).to.equal(true);
	});

	it('rejects child timetable data whose opaque ID is absent from the lesson child manifest', async () => {
		const { adapter, objects, states } = makeTestAdapter();
		const knownChildId = 'a'.repeat(64);
		const unmatchedChildId = 'c'.repeat(64);
		await adapter.commitChildLessons([childWithRecords(knownChildId, 'Known child', [])]);
		const unmatchedTimetableBase = `students.${unmatchedChildId}.timetable`;
		const records = [timetableRecord('d', unmatchedChildId, 'Wednesday', 'Physics')];
		const childTimetables: PortalChildTimetable[] = [{ id: unmatchedChildId, records }];
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'application/json',
			body: Buffer.from('{}'),
		};

		const result = await adapter.refreshResource(
			'timetable',
			() => Promise.resolve(response),
			() => ({ status: 'complete', kind: 'timetable', records, groups: [], childTimetables }),
		);

		expect(result.success).to.equal(false);
		expect(result.status).to.equal('invalid-response:unmatched-timetable-child');
		expect(states.get('students.timetable.status')?.val).to.equal('invalid-response:unmatched-timetable-child');
		expect(objects.has(unmatchedTimetableBase)).to.equal(false);
	});
});
