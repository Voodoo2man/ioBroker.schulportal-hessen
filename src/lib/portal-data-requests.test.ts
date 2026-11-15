import { createHash } from 'node:crypto';
import { expect } from 'chai';
import type { PortalResponse, PortalReadFormRequest } from './portal-session';
import { createPortalResourceRequests } from './portal-data-requests';
import type { PortalReader } from './portal-data-requests';
import { getPortalDateWindow } from './portal-dates';
import { parsePortalResource } from './portal-parser';

function success(contentType = 'text/html', body = ''): PortalResponse {
	return {
		status: 200,
		classification: 'success',
		contentType,
		body: Buffer.from(body, 'utf8'),
	};
}

describe('createPortalResourceRequests', () => {
	it('uses a non-empty CSV school calendar without issuing the fallback request', async () => {
		const requests: string[] = [];
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				if (path.includes('export=csv')) {
					return Promise.resolve(
						success('text/csv', 'start,end,summary\n2026-05-01,2026-05-01,School event'),
					);
				}
				return Promise.resolve(
					success(
						'text/calendar',
						'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:event-1\nSUMMARY:Fallback\nEND:VEVENT\nEND:VCALENDAR',
					),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const requestsByKind = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		);
		const calendar = requestsByKind.find(request => request.id === 'school-calendar');

		await calendar?.read();

		expect(requests).to.deep.equal(['/kalender.php?a=export&export=csv&year=2025']);
	});

	it('falls back to iCal when the CSV export has no events', async () => {
		const requests: string[] = [];
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				return Promise.resolve(
					path.includes('export=csv')
						? success('text/csv', 'start,end,summary\n')
						: success('text/calendar', 'BEGIN:VCALENDAR\nEND:VCALENDAR'),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const requestsByKind = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		);
		const calendar = requestsByKind.find(request => request.id === 'school-calendar');

		await calendar?.read();

		expect(requests).to.deep.equal([
			'/kalender.php?a=export&export=csv&year=2025',
			'/kalender.php?a=export&export=ical&year=2025',
		]);
	});
	it('retrieves verified lesson details once per linked course and preserves their context', async () => {
		const requests: string[] = [];
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				if (path.startsWith('/meinunterricht.php?cacheBreaker=')) {
					return Promise.resolve(
						success(
							'text/html',
							'<div id="mappen"><table><thead><tr><th>Title</th></tr></thead><tbody><tr class="printable"><td>Biology <a href="/meinunterricht.php?a=view&amp;id=42">Details</a></td></tr><tr class="printable"><td>More Biology <a href="/meinunterricht.php?a=view&amp;id=42">Details</a></td></tr></tbody></table></div>',
						),
					);
				}
				return Promise.resolve(
					success(
						'text/html',
						'<div id="marks"><table><thead><tr><th>Mark</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table></div>',
					),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const lessons = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
			1_700_000_000_000,
		).find(request => request.id === 'lessons');

		const response = await lessons?.read();
		const parsed = response && lessons?.parse?.(response.body, response.contentType);

		expect(requests).to.deep.equal([
			'/meinunterricht.php?cacheBreaker=1700000000000',
			'/meinunterricht.php?a=view&id=42',
		]);
		expect(parsed?.status).to.equal('complete');
		if (parsed?.status === 'complete') {
			expect(parsed.records).to.have.length(3);
			expect(parsed.records[2]).to.have.nested.property('context.courseId', '42');
		}
	});

	it('keeps parent lesson rows and detail context separate for each child', async () => {
		const requests: string[] = [];
		const listing =
			'<a data-toggle="tab" href="#p17">Learner Alpha</a><a data-toggle="tab" href="#p29">Learner Beta</a><div class="tab-pane" id="p17"><table><thead><tr><th>Course</th></tr></thead><tbody><tr><td>Alpha course <a href="/meinunterricht.php?a=view&amp;id=41">Details</a></td></tr></tbody></table><table><thead><tr><th>Note</th></tr></thead><tbody><tr><td>Alpha source</td></tr></tbody></table></div><div class="tab-pane" id="p29"><table><thead><tr><th>Course</th></tr></thead><tbody><tr><td>Beta course <a href="/meinunterricht.php?a=view&amp;id=52">Details</a></td></tr></tbody></table><table><thead><tr><th>Note</th></tr></thead><tbody><tr><td>Beta source</td></tr></tbody></table></div>';
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				if (path.startsWith('/meinunterricht.php?cacheBreaker=')) {
					return Promise.resolve(success('text/html', listing));
				}
				const detail = path.endsWith('id=41') ? 'Alpha detail' : 'Beta detail';
				return Promise.resolve(
					success(
						'text/html',
						`<div id="marks"><table><thead><tr><th>Result</th></tr></thead><tbody><tr><td>${detail}</td></tr></tbody></table></div>`,
					),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const lessons = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
			1_700_000_000_000,
		).find(request => request.id === 'lessons');

		const response = await lessons?.read();
		const parsed = response && lessons?.parse?.(response.body, response.contentType);

		expect(requests).to.deep.equal([
			'/meinunterricht.php?cacheBreaker=1700000000000',
			'/meinunterricht.php?a=view&id=41',
			'/meinunterricht.php?a=view&id=52',
		]);
		expect(parsed?.status).to.equal('complete');
		if (parsed?.status === 'complete') {
			const alpha = parsed.children?.[0];
			const beta = parsed.children?.[1];
			expect(alpha?.name).to.equal('Learner Alpha');
			expect(beta?.name).to.equal('Learner Beta');
			expect(alpha?.records).to.have.length(3);
			expect(beta?.records).to.have.length(3);
			expect(alpha?.sections).to.include('marks').and.include('other');
			expect(beta?.sections).to.include('marks').and.include('other');
			const alphaDetail = alpha?.records.find(
				record => record.format === 'html' && record.fields.some(field => field.text === 'Alpha detail'),
			);
			const betaDetail = beta?.records.find(
				record => record.format === 'html' && record.fields.some(field => field.text === 'Beta detail'),
			);
			expect(alphaDetail?.context).to.deep.equal({ childId: alpha?.id, courseId: '41' });
			expect(betaDetail?.context).to.deep.equal({ childId: beta?.id, courseId: '52' });
			expect(JSON.stringify(alpha?.records)).not.to.contain('Beta detail');
			expect(JSON.stringify(beta?.records)).not.to.contain('Alpha detail');
			expect(JSON.stringify(parsed)).not.to.match(/p17|p29/u);
		}
	});

	it('returns an empty child with metadata through the lesson aggregation parser', async () => {
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path.startsWith('/meinunterricht.php?cacheBreaker=')
						? success(
								'text/html',
								'<a data-toggle="tab" href="#p31">Learner Gamma</a><a data-toggle="tab" href="#p47">Learner Delta</a><div class="tab-pane" id="p31"><table><thead><tr><th>Item</th></tr></thead><tbody></tbody></table></div><div class="tab-pane" id="p47"><table><thead><tr><th>Item</th></tr></thead><tbody></tbody></table></div>',
							)
						: success(),
				),
			postRead: () => Promise.resolve(success()),
		};
		const lessons = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'lessons');

		const response = await lessons?.read();
		const parsed = response && lessons?.parse?.(response.body, response.contentType);

		expect(parsed?.status).to.equal('complete');
		if (parsed?.status === 'complete') {
			expect(parsed.children?.map(child => child.name)).to.deep.equal(['Learner Gamma', 'Learner Delta']);
			expect(parsed.children?.map(child => child.records)).to.deep.equal([[], []]);
			expect(parsed.children?.map(child => child.sections)).to.deep.equal([['other'], ['other']]);
			expect(parsed.records).to.deep.equal([]);
		}
	});

	it('preserves lesson results when any parent child detail read is incomplete', async () => {
		const requests: string[] = [];
		const listing =
			'<a data-toggle="tab" href="#p17">Learner Alpha</a><a data-toggle="tab" href="#p29">Learner Beta</a><div class="tab-pane" id="p17"><table><thead><tr><th>Course</th></tr></thead><tbody><tr><td>Alpha <a href="/meinunterricht.php?a=view&amp;id=41">Details</a></td></tr></tbody></table></div><div class="tab-pane" id="p29"><table><thead><tr><th>Course</th></tr></thead><tbody><tr><td>Beta <a href="/meinunterricht.php?a=view&amp;id=52">Details</a></td></tr></tbody></table></div>';
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				if (path.startsWith('/meinunterricht.php?cacheBreaker=')) {
					return Promise.resolve(success('text/html', listing));
				}
				return Promise.resolve(
					path.endsWith('id=41')
						? success(
								'text/html',
								'<div id="marks"><table><tr><th>Result</th></tr><tr><td>Complete</td></tr></table></div>',
							)
						: { status: 403, classification: 'forbidden', contentType: null, body: new Uint8Array() },
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const lessons = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'lessons');

		const response = await lessons?.read();

		expect(requests).to.have.length(3);
		expect(response?.classification).to.equal('forbidden');
		expect(response?.body).to.deep.equal(new Uint8Array());
	});

	it('recursively lists file metadata and retains parent-folder context', async () => {
		const requests: string[] = [];
		const table = (rows: string): string =>
			`<table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody>${rows}</tbody></table>`;
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				if (path.endsWith('folder=0')) {
					return Promise.resolve(
						success(
							'text/html',
							`<div class="folder" data-id="10"><span class="caption">Course</span><span class="desc">Main</span></div>${table('<tr data-id="1"><td>root.pdf</td><td></td><td>1 KB</td></tr>')}`,
						),
					);
				}
				if (path.endsWith('folder=10')) {
					return Promise.resolve(
						success(
							'text/html',
							`<div class="folder" data-id="11"><span class="caption">Homework</span><span class="desc">Tasks</span></div>${table('<tr data-id="2"><td>task.pdf</td><td></td><td>2 KB</td></tr>')}`,
						),
					);
				}
				return Promise.resolve(
					success('text/html', table('<tr data-id="3"><td>answer.pdf</td><td></td><td>3 KB</td></tr>')),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const files = createPortalResourceRequests(reader, getPortalDateWindow(new Date('2026-05-06T12:00:00Z'))).find(
			request => request.id === 'file-metadata',
		);

		const response = await files?.read();
		const parsed = response && files?.parse?.(response.body, response.contentType);

		expect(requests).to.deep.equal([
			'/dateispeicher.php?a=view&folder=0',
			'/dateispeicher.php?a=view&folder=10',
			'/dateispeicher.php?a=view&folder=11',
		]);
		expect(parsed?.status).to.equal('complete');
		if (parsed?.status === 'complete') {
			expect(parsed.records).to.have.length(5);
			expect(
				parsed.records.find(record => record.format === 'json' && record.fields.name === 'answer.pdf'),
			).to.have.nested.property('context.parentFolderId', '11');
		}
	});

	it('completes the current parent-folder shape within the 100-folder limit', async () => {
		const requests: string[] = [];
		const table =
			'<table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody></tbody></table>';
		const counts = [7, 5, 3, 13];
		const childrenByParent = new Map<string, string[]>();
		let nextChildId = 10;
		const rootFolders = counts
			.map((count, index) => {
				const parentId = String(index + 1);
				const childIds = Array.from({ length: count }, () => String(nextChildId++));
				childrenByParent.set(parentId, childIds);
				return `<div class="folder" data-id="${parentId}"><span class="caption">Folder ${parentId}</span><span class="desc">Description</span><span title="Anzahl Ordner">${count} Ordner</span></div>`;
			})
			.join('');
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				const folderId = path.slice(path.lastIndexOf('=') + 1);
				const childIds = childrenByParent.get(folderId) ?? [];
				const folders = childIds
					.map(
						id =>
							`<div class="folder" data-id="${id}"><span class="caption">Folder ${id}</span><span class="desc">Description</span><span title="Anzahl Ordner">0 Ordner</span></div>`,
					)
					.join('');
				return Promise.resolve(success('text/html', `${folderId === '0' ? rootFolders : folders}${table}`));
			},
			postRead: () => Promise.resolve(success()),
		};
		const files = createPortalResourceRequests(reader, getPortalDateWindow(new Date('2026-05-06T12:00:00Z'))).find(
			request => request.id === 'file-metadata',
		);

		const response = await files?.read();
		const parsed = response && files?.parse?.(response.body, response.contentType);

		expect(requests).to.have.length(33);
		expect(parsed?.status).to.equal('complete');
		if (parsed?.status === 'complete') {
			expect(parsed.records).to.have.length(32);
		}
	});

	it('does not return partial file metadata when a nested folder fails', async () => {
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path.endsWith('folder=0')
						? success(
								'text/html',
								'<div class="folder" data-id="10"><span class="caption">Course</span><span class="desc">Main</span></div><table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody></tbody></table>',
							)
						: { status: 403, classification: 'forbidden', contentType: null, body: new Uint8Array() },
				),
			postRead: () => Promise.resolve(success()),
		};
		const files = createPortalResourceRequests(reader, getPortalDateWindow(new Date('2026-05-06T12:00:00Z'))).find(
			request => request.id === 'file-metadata',
		);

		const response = await files?.read();

		expect(response?.classification).to.equal('forbidden');
	});

	it('uses server-rendered substitution tables before issuing per-day requests', async () => {
		const requests: string[] = [];
		const listing =
			'<button data-tag="12_11_2026"></button><button data-tag="13_11_2026"></button>' +
			'<table id="vtable12_11_2026"><thead><tr><th></th><th>Stunde</th><th>Klasse</th><th>Vertretung</th><th>Lehrkraft</th><th>Fach</th><th>Raum</th><th>Hinweis</th></tr></thead><tbody><tr><td></td><td>1</td><td>5a</td><td>Lesson A</td><td>Teacher A</td><td>Math</td><td>Room 1</td><td></td></tr></tbody></table>' +
			'<table id="vtable13_11_2026"><thead><tr><th></th><th>Stunde</th><th>Klasse</th><th>Vertretung</th><th>Lehrkraft</th><th>Fach</th><th>Raum</th><th>Hinweis</th></tr></thead><tbody><tr><td></td><td>2</td><td>5b</td><td>Lesson B</td><td>Teacher B</td><td>English</td><td>Room 2</td><td></td></tr></tbody></table>';
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				return Promise.resolve(success('text/html', listing));
			},
			postRead: () => {
				requests.push('POST substitution-day');
				return Promise.resolve(success('application/json', '0'));
			},
		};
		const substitutions = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'substitutions');

		const response = await substitutions?.read();
		const parsed =
			response &&
			parsePortalResource(
				'substitutions',
				Buffer.from(response.body).toString('utf8'),
				response.contentType ?? undefined,
			);

		expect(requests).to.deep.equal(['/vertretungsplan.php']);
		expect(parsed?.status).to.equal('complete');
		if (parsed?.status === 'complete') {
			expect(parsed.records).to.have.length(2);
			expect(
				parsed.records.map(record => (record.format === 'json' ? record.fields.portalDate : undefined)),
			).to.deep.equal(['12.11.2026', '13.11.2026']);
		}
	});

	it('retrieves substitution rows for every verified date and keeps their date context', async () => {
		const postDates: Array<{ date: string; portalTag: string }> = [];
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path === '/vertretungsplan.php'
						? success('text/html', '<div data-tag="06_05_2026"></div><div data-tag="07_05_2026"></div>')
						: success(),
				),
			postRead: request => {
				if (request.type === 'substitution-day') {
					postDates.push({ date: request.date, portalTag: request.portalTag });
					return Promise.resolve(
						request.date === '06.05.2026'
							? success('application/json', '[{"Stunde":"1","Fach":"Math"}]')
							: success('application/json', '[]'),
					);
				}
				return Promise.resolve(success());
			},
		};
		const resources = createPortalResourceRequests(reader, getPortalDateWindow(new Date('2026-05-06T12:00:00Z')));
		const substitutions = resources.find(request => request.id === 'substitutions');

		const response = await substitutions?.read();

		expect(postDates).to.deep.equal([
			{ date: '06.05.2026', portalTag: '06_05_2026' },
			{ date: '07.05.2026', portalTag: '07_05_2026' },
		]);
		expect(response?.classification).to.equal('success');
		expect(JSON.parse(Buffer.from(response?.body ?? []).toString('utf8'))).to.deep.equal([
			{ Stunde: '1', Fach: 'Math', portalDate: '06.05.2026' },
		]);
	});

	it('keeps substitution data incomplete when the full-plan request returns ambiguous zero', async () => {
		const reader: PortalReader = {
			get: () => Promise.resolve(success('text/html', '<div data-tag="12_11_2026"></div>')),
			postRead: () => Promise.resolve(success('text/html', '0')),
		};
		const substitutions = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'substitutions');

		const response = await substitutions?.read();

		expect(response?.classification).to.equal('unknown');
		expect(response?.body).to.deep.equal(new Uint8Array());
	});

	it('does not return partial substitution data after an advertised day fails', async () => {
		let day = 0;
		const reader: PortalReader = {
			get: () =>
				Promise.resolve(
					success('text/html', '<div data-tag="06.05.2026"></div><div data-tag="07.05.2026"></div>'),
				),
			postRead: () => {
				day++;
				return Promise.resolve(
					day === 1
						? success('application/json', '[{"Stunde":"1"}]')
						: { status: 403, classification: 'forbidden', contentType: null, body: new Uint8Array() },
				);
			},
		};
		const resources = createPortalResourceRequests(reader, getPortalDateWindow(new Date('2026-05-06T12:00:00Z')));
		const substitutions = resources.find(request => request.id === 'substitutions');

		const response = await substitutions?.read();

		expect(response?.classification).to.equal('forbidden');
	});

	it('aggregates only each child’s personal timetable from verified detail links', async () => {
		const requests: string[] = [];
		const children = [
			{ studentId: '123', classId: '07C', own: 'Personal A', all: 'Class A' },
			{ studentId: '456', classId: '08B', own: 'Personal B', all: 'Class B' },
		];
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				if (path === '/stundenplan.php') {
					return Promise.resolve(
						success(
							'text/html',
							'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child A</a><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=08B&amp;p=456">Child B</a></div></div>',
						),
					);
				}
				const child = children.find(item => path.endsWith(`p=${item.studentId}`));
				if (!child) {
					return Promise.resolve({
						status: 404,
						classification: 'not-found',
						contentType: null,
						body: new Uint8Array(),
					});
				}
				return Promise.resolve(
					success(
						'text/html',
						`<section id="all"><table><thead><tr><th>Klassenplan</th></tr></thead><tbody><tr><td>${child.all}</td></tr></tbody></table></section><section id="own"><table><thead><tr><th>Eigener Plan</th></tr></thead><tbody><tr><td>${child.own}</td></tr></tbody></table></section>`,
					),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();
		const result = response && timetable?.parse?.(response.body, response.contentType);

		expect(requests).to.deep.equal([
			'/stundenplan.php',
			'/stundenplan.php?e=1&a=detail_klasse&k=07C&p=123',
			'/stundenplan.php?e=1&a=detail_klasse&k=08B&p=456',
		]);
		expect(result?.status).to.equal('complete');
		if (result?.status === 'complete') {
			expect(result.childTimetables).to.have.length(2);
			expect(result.childTimetables?.map(child => child.id)).to.deep.equal([
				createHash('sha256').update('p123').digest('hex'),
				createHash('sha256').update('p456').digest('hex'),
			]);
			expect(
				result.childTimetables?.map(child =>
					child.records.map(record => record.format === 'html' && record.fields[0]?.text),
				),
			).to.deep.equal([['Personal A'], ['Personal B']]);
			expect(JSON.stringify(result)).not.to.contain('Class A');
			expect(JSON.stringify(result)).not.to.contain('Class B');
		}
	});

	it('expands personal weekday-column tables into day-specific lesson records', async () => {
		const detail =
			'<section id="all"><table><thead><tr><th>Stunde</th><th>Montag</th><th>Dienstag</th></tr></thead><tbody><tr><td>1</td><td>Class-only data</td><td></td></tr></tbody></table></section>' +
			'<section id="own"><table><thead><tr><th>Stunde</th><th>Montag</th><th>Dienstag</th></tr></thead><tbody><tr><td rowspan="2">1</td><td>Personal math</td><td></td></tr><tr><td></td><td>Personal science</td></tr></tbody></table></section>';
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path === '/stundenplan.php'
						? success(
								'text/html',
								'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
							)
						: success('text/html', detail),
				),
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();
		const result = response && timetable?.parse?.(response.body, response.contentType);

		expect(result?.status).to.equal('complete');
		if (result?.status === 'complete') {
			const child = result.childTimetables?.[0];
			expect(child?.records).to.have.length(2);
			expect(
				child?.records.map(record =>
					record.format === 'html'
						? {
								weekday: record.context?.timetableWeekday,
								fields: record.fields.map(field => ({ header: field.header, text: field.text })),
							}
						: null,
				),
			).to.deep.equal([
				{
					weekday: 'monday',
					fields: [
						{ header: 'Stunde', text: '1' },
						{ header: 'Lesson', text: 'Personal math' },
					],
				},
				{
					weekday: 'tuesday',
					fields: [
						{ header: 'Stunde', text: '1' },
						{ header: 'Lesson', text: 'Personal science' },
					],
				},
			]);
			expect(JSON.stringify(result)).not.to.contain('Class-only data');
		}
	});

	it('normalizes whitespace in parent weekday-grid records without changing tokens or derived times', async () => {
		const spaces = ' '.repeat(128);
		const detail =
			'<section id="own"><table><thead><tr><th>Stunde</th><th>Montag</th><th>Dienstag</th></tr></thead><tbody>' +
			`<tr><td>\n  1${spaces}\n  07:45\t–\n  08:30  \n</td><td>\n  BIO${spaces}1-109\n${spaces}WIS \n</td><td></td></tr>` +
			'</tbody></table></section>';
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path === '/stundenplan.php'
						? success(
								'text/html',
								'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
							)
						: success('text/html', detail),
				),
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();
		const result = response && timetable?.parse?.(response.body, response.contentType);

		expect(result?.status).to.equal('complete');
		if (result?.status === 'complete') {
			const record = result.childTimetables?.[0]?.records[0];
			expect(record?.format).to.equal('html');
			if (record?.format === 'html') {
				expect(record.fields.map(({ header, text }) => ({ header, text }))).to.deep.equal([
					{ header: 'Stunde', text: '1 07:45 – 08:30' },
					{ header: 'Lesson', text: 'BIO 1-109 WIS' },
					{ header: 'Start time', text: '07:45' },
					{ header: 'End time', text: '08:30' },
				]);
			}
		}
	});

	it('adds period times only for one valid range', async () => {
		const periodRows = [
			{ period: '1 (7:45 – 08:30)', lesson: 'Valid en-dash range' },
			{ period: '2 9:00-10:00', lesson: 'Valid hyphen range' },
			{ period: '3 08:60–09:00', lesson: 'Invalid minute' },
			{ period: '4', lesson: 'Missing range' },
			{ period: '5 09:00–08:45', lesson: 'Reversed range' },
			{ period: '6 08:00-08:45 / 09:00-09:45', lesson: 'Ambiguous ranges' },
			{ period: '7 24:00-25:00', lesson: 'Invalid hours' },
			{ period: '8 08:00-', lesson: 'Incomplete range' },
		];
		const rows = periodRows
			.map(({ period, lesson }) => `<tr><td>${period}</td><td>${lesson}</td><td></td></tr>`)
			.join('');
		const detail = `<section id="own"><table><thead><tr><th>Stunde</th><th>Montag</th><th>Dienstag</th></tr></thead><tbody>${
			rows
		}</tbody></table></section>`;
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path === '/stundenplan.php'
						? success(
								'text/html',
								'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
							)
						: success('text/html', detail),
				),
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();
		const result = response && timetable?.parse?.(response.body, response.contentType);

		expect(result?.status).to.equal('complete');
		if (result?.status === 'complete') {
			const records = result.childTimetables?.[0]?.records;
			expect(records).to.have.length(periodRows.length);
			expect(
				records?.map(record =>
					record.format === 'html' ? record.fields.map(({ header, text }) => ({ header, text })) : null,
				),
			).to.deep.equal(
				periodRows.map(({ period, lesson }, index) => [
					{ header: 'Stunde', text: period },
					{ header: 'Lesson', text: lesson },
					...(index === 0
						? [
								{ header: 'Start time', text: '07:45' },
								{ header: 'End time', text: '08:30' },
							]
						: index === 1
							? [
									{ header: 'Start time', text: '09:00' },
									{ header: 'End time', text: '10:00' },
								]
							: []),
				]),
			);
		}
	});

	it('recovers a linked child timetable only from a structurally verified own section when surrounding HTML is malformed', async () => {
		const requests: string[] = [];
		const detail =
			'<section id="all"><table><thead><tr><th>Day</th><th>Subject</th></tr></thead><tbody><tr><td>Tuesday</td><td>Class-wide placeholder</td></tr></tbody></table></section><section id="own"><table><thead><tr><th>Day</th><th>Subject</th></tr></thead><tbody><tr><td>Tuesday</td><td>Personal synthetic lesson</td></tr></tbody></table></section><div>';
		const reader: PortalReader = {
			get: path => {
				requests.push(path);
				return Promise.resolve(
					path === '/stundenplan.php'
						? success(
								'text/html',
								'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
							)
						: success('text/html', detail),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		expect(parsePortalResource('timetable', detail)).to.include({ status: 'invalid', reason: 'malformed-html' });
		const response = await timetable?.read();
		const result = response && timetable?.parse?.(response.body, response.contentType);

		expect(requests).to.deep.equal(['/stundenplan.php', '/stundenplan.php?e=1&a=detail_klasse&k=07C&p=123']);
		expect(result?.status).to.equal('complete');
		if (result?.status === 'complete') {
			const child = result.childTimetables?.[0];
			expect(child?.id).to.equal(createHash('sha256').update('p123').digest('hex'));
			expect(child?.records).to.have.length(1);
			expect(child?.records[0]).to.include({ section: 'own' });
			expect(child?.records[0]?.context?.childId).to.equal(child?.id);
			expect(
				child?.records[0]?.format === 'html' && child.records[0].fields.map(field => field.text),
			).to.deep.equal(['Tuesday', 'Personal synthetic lesson']);
			expect(JSON.stringify(result)).not.to.contain('Class-wide placeholder');
		}
	});

	it('does not recover malformed child timetable pages from class-wide tables alone', async () => {
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path === '/stundenplan.php'
						? success(
								'text/html',
								'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
							)
						: success(
								'text/html',
								'<section id="all"><table><thead><tr><th>Day</th></tr></thead><tbody><tr><td>Tuesday</td></tr></tbody></table></section><div>',
							),
				),
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();

		expect(response?.classification).to.equal('unknown');
		expect(response?.diagnosticCode).to.equal('timetable-child-detail-invalid-malformed-html');
	});

	it('accepts a confirmed empty personal timetable without using the class timetable', async () => {
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path === '/stundenplan.php'
						? success(
								'text/html',
								'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
							)
						: success(
								'text/html',
								'<section id="all"><table><thead><tr><th>Klassenplan</th></tr></thead><tbody><tr><td>Class only</td></tr></tbody></table></section><section id="own"><table><thead><tr><th>Eigener Plan</th></tr></thead><tbody></tbody></table></section>',
							),
				),
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();
		const result = response && timetable?.parse?.(response.body, response.contentType);

		expect(result?.status).to.equal('complete');
		if (result?.status === 'complete') {
			expect(result.childTimetables).to.have.length(1);
			expect(result.childTimetables?.[0]?.records).to.deep.equal([]);
			expect(JSON.stringify(result)).not.to.contain('Class only');
		}
	});

	it('does not commit a partial child timetable when a detail page has no own section', async () => {
		let detailReads = 0;
		const reader: PortalReader = {
			get: path => {
				if (path === '/stundenplan.php') {
					return Promise.resolve(
						success(
							'text/html',
							'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
						),
					);
				}
				detailReads++;
				return Promise.resolve(
					success(
						'text/html',
						'<section id="all"><table><thead><tr><th>Klassenplan</th></tr></thead><tbody><tr><td>Class only</td></tr></tbody></table></section>',
					),
				);
			},
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();

		expect(detailReads).to.equal(1);
		expect(response?.classification).to.equal('unknown');
		expect(response?.diagnosticCode).to.equal('timetable-child-own-section-missing');
		expect(response?.body).to.have.length(0);
	});

	it('preserves a safe parser reason when a linked timetable detail has tables outside verified sections', async () => {
		const reader: PortalReader = {
			get: path =>
				Promise.resolve(
					path === '/stundenplan.php'
						? success(
								'text/html',
								'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
							)
						: success(
								'text/html',
								'<table><thead><tr><th>Fach</th></tr></thead><tbody><tr><td>Private row</td></tr></tbody></table>',
							),
				),
			postRead: () => Promise.resolve(success()),
		};
		const timetable = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'timetable');

		const response = await timetable?.read();

		expect(response?.classification).to.equal('unknown');
		expect(response?.diagnosticCode).to.equal(
			'timetable-child-detail-invalid-timetable-sections-missing-with-tables',
		);
		expect(Buffer.from(response?.body ?? []).toString('utf8')).to.equal('');
	});

	it('uses only verified GET pages and read-only form actions with Berlin-local dates', async () => {
		const requests: Array<{ method: string; target: string | PortalReadFormRequest }> = [];
		const reader: PortalReader = {
			get: path => {
				requests.push({ method: 'GET', target: path });
				return Promise.resolve(success());
			},
			postRead: request => {
				requests.push({ method: 'POST', target: request });
				return Promise.resolve(success());
			},
		};
		const window = getPortalDateWindow(new Date('2026-03-29T23:30:00.000Z'));
		const resources = createPortalResourceRequests(reader, window, 1_700_000_000_000);

		for (const resource of resources) {
			await resource.read();
		}

		expect(resources.map(resource => resource.id)).to.deep.equal([
			'account',
			'substitutions',
			'calendar',
			'school-calendar',
			'lessons',
			'timetable',
			'learning-groups',
			'messages',
			'file-metadata',
		]);
		expect(requests).to.deep.equal([
			{ method: 'GET', target: '/benutzerverwaltung.php?a=userData' },
			{ method: 'GET', target: '/vertretungsplan.php' },
			{
				method: 'POST',
				target: { type: 'calendar-events', start: '2025-11-30', end: '2027-03-21' },
			},
			{ method: 'GET', target: '/kalender.php?a=export&export=csv&year=2025' },
			{ method: 'GET', target: '/kalender.php?a=export&export=ical&year=2025' },
			{ method: 'GET', target: '/meinunterricht.php?cacheBreaker=1700000000000' },
			{ method: 'GET', target: '/stundenplan.php' },
			{ method: 'GET', target: '/lerngruppen.php' },
			{ method: 'POST', target: { type: 'message-headers' } },
			{ method: 'GET', target: '/dateispeicher.php?a=view&folder=0' },
		]);
	});

	it('aggregates validated detail text only for visible headers and hashes source IDs', async () => {
		const messageId = createHash('sha256').update('source-message-1').digest('hex');
		const replyId = createHash('sha256').update('source-reply-1').digest('hex');
		const calls: PortalReadFormRequest[] = [];
		const reader: PortalReader = {
			get: () => Promise.resolve(success()),
			postRead: request => {
				calls.push(request);
				if (request.type === 'message-headers') {
					return Promise.resolve(
						success(
							'application/json',
							JSON.stringify([
								{
									id: messageId,
									subject: 'Visible subject',
									date: '06.05.2026',
									unread: true,
									hidden: false,
								},
								{
									id: createHash('sha256').update('source-hidden-1').digest('hex'),
									subject: 'Hidden subject',
									unread: false,
									hidden: true,
								},
							]),
						),
					);
				}
				return Promise.resolve(
					success(
						'application/json',
						JSON.stringify({
							id: messageId,
							date: '06.05.2026',
							username: 'Teacher',
							own: false,
							content: '<p>Conversation text</p>',
							replies: [
								{
									id: replyId,
									date: '07.05.2026',
									username: 'Student',
									own: true,
									content: 'Reply text',
								},
							],
							time: 1_700_000_000_000,
							groupChat: false,
							onlyPrivateAnswers: false,
							noReply: false,
							participantCounts: { students: 1, teachers: 1, parents: 0 },
						}),
					),
				);
			},
		};
		const messages = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'messages');
		const response = await messages?.read();
		const parsed =
			response &&
			parsePortalResource('messages', Buffer.from(response.body).toString('utf8'), 'application/json');

		expect(calls).to.deep.equal([
			{ type: 'message-headers' },
			{ type: 'message-detail', messageIdHash: messageId },
		]);
		expect(response?.classification).to.equal('success');
		expect(parsed?.status).to.equal('complete');
		if (parsed?.status === 'complete') {
			expect(parsed.records).to.have.length(2);
			const visible = parsed.records[0];
			expect(visible.format === 'json' && visible.fields).to.include({
				id: messageId,
				subject: 'Visible subject',
				content: 'Conversation text',
			});
			expect(visible.format === 'json' && visible.fields.replies).to.deep.equal([
				{ id: replyId, date: '07.05.2026', username: 'Student', own: true, content: 'Reply text' },
			]);
			expect(parsed.records[1].format === 'json' && parsed.records[1].fields).not.to.have.property('content');
		}
		expect(Buffer.from(response?.body ?? []).toString('utf8')).not.to.contain('source-message-1');
	});

	it('does not open hidden messages and rejects an inbox exceeding the detail limit before opening any', async () => {
		const hiddenCalls: PortalReadFormRequest[] = [];
		const hiddenReader: PortalReader = {
			get: () => Promise.resolve(success()),
			postRead: request => {
				hiddenCalls.push(request);
				return Promise.resolve(
					success(
						'application/json',
						JSON.stringify([{ id: 'a'.repeat(64), subject: 'Hidden', unread: false, hidden: true }]),
					),
				);
			},
		};
		const hiddenMessages = createPortalResourceRequests(
			hiddenReader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'messages');
		const hiddenResponse = await hiddenMessages?.read();

		const unknownMetadataCalls: PortalReadFormRequest[] = [];
		const unknownMetadataReader: PortalReader = {
			get: () => Promise.resolve(success()),
			postRead: request => {
				unknownMetadataCalls.push(request);
				return Promise.resolve(
					success('application/json', JSON.stringify([{ id: 'b'.repeat(64), hidden: false }])),
				);
			},
		};
		const unknownMetadataMessages = createPortalResourceRequests(
			unknownMetadataReader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'messages');
		const unknownMetadataResponse = await unknownMetadataMessages?.read();

		const limitedCalls: PortalReadFormRequest[] = [];
		const limitedReader: PortalReader = {
			get: () => Promise.resolve(success()),
			postRead: request => {
				limitedCalls.push(request);
				return Promise.resolve(
					success(
						'application/json',
						JSON.stringify(
							Array.from({ length: 21 }, (_, index) => ({
								id: createHash('sha256').update(`message-${index}`).digest('hex'),
								subject: `Message ${index}`,
								unread: false,
								hidden: false,
							})),
						),
					),
				);
			},
		};
		const limitedMessages = createPortalResourceRequests(
			limitedReader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'messages');
		const limitedResponse = await limitedMessages?.read();

		expect(hiddenResponse?.classification).to.equal('success');
		expect(hiddenCalls).to.deep.equal([{ type: 'message-headers' }]);
		expect(unknownMetadataResponse?.classification).to.equal('unknown');
		expect(unknownMetadataResponse?.diagnosticCode).to.equal('message-header-metadata-unverified');
		expect(unknownMetadataCalls).to.deep.equal([{ type: 'message-headers' }]);
		expect(limitedResponse?.classification).to.equal('unknown');
		expect(limitedResponse?.diagnosticCode).to.equal('message-detail-limit-exceeded');
		expect(limitedCalls).to.deep.equal([{ type: 'message-headers' }]);
	});

	it('returns no partial inbox when a later detail request fails', async () => {
		const calls: PortalReadFormRequest[] = [];
		let discardCalled = false;
		const ids = ['first', 'second'].map(value => createHash('sha256').update(value).digest('hex'));
		const reader: PortalReader = {
			get: () => Promise.resolve(success()),
			postRead: request => {
				calls.push(request);
				if (request.type === 'message-headers') {
					return Promise.resolve(
						success(
							'application/json',
							JSON.stringify(ids.map(id => ({ id, unread: false, hidden: false }))),
						),
					);
				}
				if (request.type !== 'message-detail') {
					return Promise.resolve(success());
				}
				if (request.messageIdHash === ids[1]) {
					return Promise.resolve({
						status: 403,
						classification: 'forbidden',
						contentType: null,
						body: new Uint8Array(),
					});
				}
				return Promise.resolve(
					success(
						'application/json',
						JSON.stringify({
							id: ids[0],
							date: '06.05.2026',
							username: 'Teacher',
							own: false,
							content: 'Partial private content',
							replies: [],
							time: 1_700_000_000_000,
							groupChat: false,
							onlyPrivateAnswers: false,
							noReply: false,
							participantCounts: { students: 1, teachers: 1, parents: 0 },
						}),
					),
				);
			},
			discardMessageSourceIds: () => {
				discardCalled = true;
			},
		};
		const messages = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'messages');
		const response = await messages?.read();

		expect(response?.classification).to.equal('forbidden');
		expect(Buffer.from(response?.body ?? []).toString('utf8')).to.equal('');
		expect(calls.filter(request => request.type === 'message-detail')).to.have.length(2);
		expect(discardCalled).to.equal(true);
	});

	it('bounds the combined portal response payload for inbox headers and details', async () => {
		const calls: PortalReadFormRequest[] = [];
		const ids = ['first', 'second'].map(value => createHash('sha256').update(value).digest('hex'));
		const reader: PortalReader = {
			get: () => Promise.resolve(success()),
			postRead: request => {
				calls.push(request);
				if (request.type === 'message-headers') {
					return Promise.resolve({
						...success(
							'application/json',
							JSON.stringify(ids.map(id => ({ id, unread: false, hidden: false }))),
						),
						bodyByteLength: 100,
					});
				}
				if (request.type !== 'message-detail') {
					return Promise.resolve(success());
				}
				return Promise.resolve({
					...success(
						'application/json',
						JSON.stringify({
							id: request.messageIdHash,
							date: '06.05.2026',
							username: 'Teacher',
							own: false,
							content: 'Small response body',
							replies: [],
							time: 1_700_000_000_000,
							groupChat: false,
							onlyPrivateAnswers: false,
							noReply: false,
							participantCounts: { students: 1, teachers: 1, parents: 0 },
						}),
					),
					bodyByteLength: 2_200_000,
				});
			},
		};
		const messages = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'messages');
		const response = await messages?.read();

		expect(response?.classification).to.equal('unknown');
		expect(response?.diagnosticCode).to.equal('message-aggregation-limit-exceeded');
		expect(calls.filter(request => request.type === 'message-detail')).to.have.length(2);
		expect(Buffer.from(response?.body ?? []).toString('utf8')).to.equal('');
	});

	it('discards an over-limit inbox aggregation instead of returning partial details', async () => {
		const calls: PortalReadFormRequest[] = [];
		const headers = Array.from({ length: 20 }, (_, index) => ({
			id: createHash('sha256').update(`message-${index}`).digest('hex'),
			subject: `Message ${index}`,
			unread: false,
			hidden: false,
		}));
		const reader: PortalReader = {
			get: () => Promise.resolve(success()),
			postRead: request => {
				calls.push(request);
				if (request.type === 'message-headers') {
					return Promise.resolve(success('application/json', JSON.stringify(headers)));
				}
				if (request.type !== 'message-detail') {
					return Promise.resolve(success());
				}
				return Promise.resolve(
					success(
						'application/json',
						JSON.stringify({
							id: request.messageIdHash,
							date: '06.05.2026',
							username: 'Teacher',
							own: false,
							content: 'x'.repeat(250_000),
							replies: [],
							time: 1_700_000_000_000,
							groupChat: false,
							onlyPrivateAnswers: false,
							noReply: false,
							participantCounts: { students: 1, teachers: 1, parents: 0 },
						}),
					),
				);
			},
		};
		const messages = createPortalResourceRequests(
			reader,
			getPortalDateWindow(new Date('2026-05-06T12:00:00Z')),
		).find(request => request.id === 'messages');
		const response = await messages?.read();

		expect(response?.classification).to.equal('unknown');
		expect(response?.diagnosticCode).to.equal('message-aggregation-limit-exceeded');
		expect(calls.filter(request => request.type === 'message-detail').length).to.be.lessThan(20);
		expect(Buffer.from(response?.body ?? []).toString('utf8')).to.equal('');
	});
});
