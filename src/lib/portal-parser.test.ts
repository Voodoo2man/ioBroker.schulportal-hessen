import { createHash } from 'node:crypto';
import { expect } from 'chai';
import { parsePortalResource } from './portal-parser';

describe('parsePortalResource', () => {
	it('maps file rows to safe metadata and preserves table headers without exposing download URLs', () => {
		const result = parsePortalResource(
			'file-metadata',
			'<html><body><table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th><th>Note</th></tr></thead><tbody><tr data-id="17"><td><a href="/dateispeicher.php?download=17&amp;token=private">Plan.pdf</a></td><td>07.05.2026 08:15</td><td>3 KB</td><td>Visible note</td></tr></tbody></table></body></html>',
			'text/html; charset=utf-8',
		);

		expect(result.status).to.equal('complete');
		if (result.status !== 'complete') {
			return;
		}
		expect(result.records).to.have.length(1);
		const record = result.records[0];
		expect(record.format).to.equal('json');
		if (record.format !== 'json') {
			return;
		}
		expect(record.id).to.match(/^source:[a-f0-9]{64}$/u);
		expect(record.fields).to.deep.equal({
			recordType: 'file',
			fileId: '17',
			name: 'Plan.pdf',
			modified: '07.05.2026 08:15',
			size: '3 KB',
			note: 'Visible note',
			columns: [
				{ header: 'Name', value: 'Plan.pdf' },
				{ header: 'Änderung', value: '07.05.2026 08:15' },
				{ header: 'Größe', value: '3 KB' },
				{ header: 'Note', value: 'Visible note' },
			],
		});
		expect(JSON.stringify(result)).not.to.match(/dateispeicher\.php|download=|private/u);
		expect(result.groups[0]).to.include({ section: 'files' });
		expect(result.groups[0].headers[0].map(cell => cell.text)).to.deep.equal(['Name', 'Änderung', 'Größe', 'Note']);
	});

	it('recognizes the German description header as a file note alias', () => {
		const result = parsePortalResource(
			'file-metadata',
			'<table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th><th>Beschreibung</th></tr></thead><tbody><tr><td>Plan</td><td></td><td></td><td>Visible note</td></tr></tbody></table>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const file = result.records[0];
			expect(file.format).to.equal('json');
			if (file.format === 'json') {
				expect(file.fields).to.include({ recordType: 'file', name: 'Plan', note: 'Visible note' });
			}
		}
	});

	it('parses verified folders and exposes only numeric traversal IDs', () => {
		const result = parsePortalResource(
			'file-metadata',
			'<div class="folder" data-id="31"><span class="caption">Homework</span><span class="desc">Current work</span><span title="Anzahl Ordner">2</span><a href="/dateispeicher.php?download=secret">Folder</a></div><table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody></tbody></table>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.records).to.have.length(1);
			const folder = result.records[0];
			expect(folder.format).to.equal('json');
			if (folder.format === 'json') {
				expect(folder.fields).to.deep.equal({
					recordType: 'folder',
					folderId: '31',
					name: 'Homework',
					description: 'Current work',
					subfolderCount: 2,
				});
				expect(folder.id).to.match(/^source:[a-f0-9]{64}$/u);
			}
			expect(JSON.stringify(result)).not.to.contain('download=secret');
		}
	});

	it('parses folder counts with the portal label and rejects malformed counts', () => {
		const result = parsePortalResource(
			'file-metadata',
			'<div class="folder" data-id="31"><span class="caption">Homework</span><span class="desc">Current work</span><span title="Anzahl Ordner">7 Ordner</span></div><table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody></tbody></table>',
		);
		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const folder = result.records[0];
			expect(folder.format).to.equal('json');
			if (folder.format === 'json') {
				expect(folder.fields.subfolderCount).to.equal(7);
			}
		}

		expect(
			parsePortalResource(
				'file-metadata',
				'<div class="folder" data-id="31"><span class="caption">Homework</span><span class="desc">Current work</span><span title="Anzahl Ordner">7 Ordner und Dateien</span></div><table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody></tbody></table>',
			),
		).to.deep.equal({ status: 'invalid', kind: 'file-metadata', reason: 'unexpected-html-structure' });
	});

	it('omits unsafe file IDs, sensitive attributes, and all file links', () => {
		const result = parsePortalResource(
			'file-metadata',
			'<table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody><tr id="session-raw-id" data-id="session-secret" data-session="private-session"><td data-cookie="sid=private-cookie"><a id="token-secret-id" href="/dateispeicher.php?s=private-session&amp;file=42" data-token="private-token">Download</a> <a href="https://external.example/file?token=private-token">External link</a></td><td></td><td></td></tr></tbody></table>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const record = result.records[0];
			expect(record.format).to.equal('json');
			if (record.format === 'json') {
				expect(record.fields).to.include({ recordType: 'file', name: 'Download External link' });
			}
			expect(record.id).not.to.contain('session-raw-id');
			expect(JSON.stringify(result)).not.to.match(
				/private-session|private-cookie|private-token|external\.example|session-secret|download=|file=42/u,
			);
		}
	});

	it('extracts opaque timetable links from the child tab panel', () => {
		const result = parsePortalResource(
			'timetable',
			'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child A</a><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=08B&amp;p=456">Child B</a></div></div>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.timetableChildren).to.deep.equal([
				{
					id: createHash('sha256').update('p123').digest('hex'),
					requestPath: '/stundenplan.php?e=1&a=detail_klasse&k=07C&p=123',
				},
				{
					id: createHash('sha256').update('p456').digest('hex'),
					requestPath: '/stundenplan.php?e=1&a=detail_klasse&k=08B&p=456',
				},
			]);
			expect(JSON.stringify(result)).not.to.contain('Lernende A');
			expect(JSON.stringify(result)).not.to.contain('Lernende B');
		}
	});

	it('rejects malformed timetable child links rather than using them as request paths', () => {
		const result = parsePortalResource(
			'timetable',
			'<a id="learners-tab" href="#learners" role="tab">Lernende</a><div id="learners" role="tabpanel" aria-labelledby="learners-tab"><div class="list-group"><a href="https://outside.example/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Child</a></div></div>',
		);

		expect(result).to.deep.equal({ status: 'invalid', kind: 'timetable', reason: 'timetable-child-links-invalid' });
	});

	it('does not treat a matching link in an unrelated tab as a learner timetable', () => {
		const result = parsePortalResource(
			'timetable',
			'<a id="other-tab" href="#other" role="tab">Other</a><div id="other" role="tabpanel" aria-labelledby="other-tab"><div class="list-group"><a href="/stundenplan.php?e=1&amp;a=detail_klasse&amp;k=07C&amp;p=123">Not a learner tab</a></div></div>',
		);

		expect(result.status).to.equal('invalid');
	});

	it('uses confirmed timetable sections and retains their grouping', () => {
		const result = parsePortalResource(
			'timetable',
			'<html><body><section id="all"><table><thead><tr><th>Day</th><th>Time</th></tr></thead><tbody><tr><td>Monday</td><td>08:00</td></tr></tbody></table></section><section id="own"><table><thead><tr><th>Day</th></tr></thead><tbody><tr><td>Tuesday</td></tr></tbody></table></section></body></html>',
		);

		expect(result.status).to.equal('complete');
		if (result.status !== 'complete') {
			return;
		}
		expect(result.records.map(record => record.format === 'html' && record.section)).to.deep.equal(['all', 'own']);
		expect(result.records[0].id).to.match(/^hash:[a-f0-9]{64}$/u);
	});

	it('collapses whitespace in every field of verified timetable HTML records', () => {
		const longWhitespace = ' '.repeat(80);
		const result = parsePortalResource(
			'timetable',
			`<section id="own"><table><thead><tr><th>Column A</th><th>Column B</th></tr></thead><tbody><tr><td>\n  01\n    07:45\t–\n  08:30  </td><td>\n BIO${longWhitespace}1-109\n\tWIS \n</td></tr></tbody></table></section>`,
		);

		expect(result.status).to.equal('complete');
		if (result.status !== 'complete') {
			return;
		}
		expect(result.records).to.have.length(1);
		const record = result.records[0];
		expect(record.format).to.equal('html');
		if (record.format === 'html') {
			expect(record.section).to.equal('own');
			expect(record.fields.map(field => field.text)).to.deep.equal(['01 07:45 – 08:30', 'BIO 1-109 WIS']);
			expect(record.id).to.match(/^hash:[a-f0-9]{64}$/u);
			expect(result.groups[0].recordIds).to.deep.equal([record.id]);
		}
	});

	it('classifies footer-only timetable tables as unavailable instead of timetable data', () => {
		const result = parsePortalResource(
			'timetable',
			'<html><body><footer class="footer"><table><thead><tr><th>Navigation</th></tr></thead><tbody><tr><td>Footer link</td></tr></tbody></table></footer></body></html>',
		);

		expect(result).to.deep.equal({ status: 'unavailable', kind: 'timetable', reason: 'feature-unavailable' });
	});

	it('retains the verified learning-group and assessment sections', () => {
		const result = parsePortalResource(
			'learning-groups',
			'<html><body><section id="LGs"><table><thead><tr><th>Course</th></tr></thead><tbody><tr id="course-1"><td>Biology</td></tr></tbody></table></section><section id="klausuren"><table><thead><tr><th>Assessment</th></tr></thead><tbody><tr><td>Exam</td></tr></tbody></table></section></body></html>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.groups.map(group => group.section)).to.deep.equal(['LGs', 'klausuren']);
			expect(result.records.map(record => record.format === 'html' && record.section)).to.deep.equal([
				'LGs',
				'klausuren',
			]);
			expect(result.records[0].id).to.match(/^source:[a-f0-9]{64}$/u);
			expect(JSON.stringify(result.records[0])).not.to.contain('course-1');
		}
	});

	it('preserves display-only homework markers and extracts only exact lesson detail references', () => {
		const result = parsePortalResource(
			'lessons',
			'<html><body><div id="mappen"><table><thead><tr><th>Title</th></tr></thead><tbody><tr><td>Navigation</td></tr><tr class="printable" data-entry="worksheet-1"><td>Worksheet 1 <span class="homework realHomework undone">not completed</span><a href="/meinunterricht.php?a=view&amp;id=42">Details</a></td></tr><tr class="printable"><td>Wrong link <a href="/meinunterricht.php?a=view&amp;id=43&amp;jump=no">Details</a></td></tr></tbody></table></div></body></html>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.records).to.have.length(2);
			expect(result.children).to.equal(undefined);
			const first = result.records[0];
			expect(first.format).to.equal('html');
			if (first.format === 'html') {
				expect(first.fields[0].text).to.contain('Worksheet 1');
				expect(first.courseId).to.equal('42');
				expect(first.markers).to.deep.equal(['homework', 'realHomework', 'undone']);
				expect(first.attributes['data-entry']).to.equal('worksheet-1');
			}
			const second = result.records[1];
			expect(second.format === 'html' && second.courseId).to.equal(undefined);
			expect(JSON.stringify(result)).not.to.match(/meinunterricht\.php|id=42|jump=no/u);
			expect(JSON.stringify(result)).not.to.contain('done: true');
		}
	});

	it('parses parent tabs into separate children and ignores tables outside the matched panels', () => {
		const result = parsePortalResource(
			'lessons',
			'<a data-toggle="tab" href="#p17">Learner Alpha</a><a data-toggle="tab" href="#p29">Learner Beta</a><table><tr><th>Outside</th></tr><tr><td>Ignored row</td></tr></table><div class="tab-pane" id="p17"><table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>Alpha task</td></tr></tbody></table><table><thead><tr><th>Note</th></tr></thead><tbody><tr><td>Alpha note</td></tr></tbody></table></div><div class="tab-pane" id="p29"><table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>Beta task</td></tr></tbody></table><table><thead><tr><th>Note</th></tr></thead><tbody><tr><td>Beta note</td></tr></tbody></table></div>',
		);

		expect(result.status).to.equal('complete');
		if (result.status !== 'complete') {
			return;
		}
		expect(result.children?.map(child => child.name)).to.deep.equal(['Learner Alpha', 'Learner Beta']);
		expect(result.children?.map(child => child.records.length)).to.deep.equal([2, 2]);
		expect(result.records).to.have.length(4);
		const [alpha, beta] = result.children ?? [];
		expect(alpha?.id).to.match(/^[a-f0-9]{64}$/u);
		expect(beta?.id).to.match(/^[a-f0-9]{64}$/u);
		expect(alpha?.id).not.to.equal(beta?.id);
		expect(JSON.stringify(result)).not.to.match(/p17|p29|Outside|Ignored row/u);
		expect(alpha?.records.map(record => record.format === 'html' && record.fields[0]?.text)).to.deep.equal([
			'Alpha task',
			'Alpha note',
		]);
		expect(alpha?.records.every(record => record.format === 'html' && record.section === 'child-lessons')).to.equal(
			true,
		);
		expect(beta?.records.map(record => record.format === 'html' && record.fields[0]?.text)).to.deep.equal([
			'Beta task',
			'Beta note',
		]);
		for (const child of result.children ?? []) {
			for (const record of child.records) {
				expect(record.context?.childId).to.equal(child.id);
			}
		}
	});

	it('keeps parent lesson rows distinct when the portal reuses data-entry identifiers', () => {
		const rows = [
			'<tr data-entry="shared-entry"><td>Mathematics</td><td>Task A</td></tr>',
			'<tr data-entry="shared-entry"><td>Science</td><td>Task B</td></tr>',
		];
		const parseRows = (orderedRows: readonly string[]): ReturnType<typeof parsePortalResource> =>
			parsePortalResource(
				'lessons',
				`<a data-toggle="tab" href="#p17">Learner</a><div class="tab-pane" id="p17"><a data-toggle="tab" href="#aktuell17">Current</a><div class="tab-pane" id="aktuell17"><table><thead><tr><th>Course</th><th>Entry</th></tr></thead><tbody>${orderedRows.join('')}</tbody></table></div></div>`,
			);
		const result = parseRows(rows);
		const reordered = parseRows([...rows].reverse());

		expect(result.status).to.equal('complete');
		expect(reordered.status).to.equal('complete');
		if (result.status === 'complete' && reordered.status === 'complete') {
			const byCourse = (parsed: typeof result): Map<string | undefined, string> =>
				new Map(
					(parsed.children?.[0]?.records ?? []).flatMap(record =>
						record.format === 'html' ? [[record.fields[0]?.text, record.id] as const] : [],
					),
				);
			expect(result.children?.[0]?.records.map(record => record.id)).to.have.length(2);
			expect(new Set(result.children?.[0]?.records.map(record => record.id)).size).to.equal(2);
			expect(
				result.children?.[0]?.records.every(
					record =>
						record.format === 'html' &&
						record.section === 'child-lessons' &&
						record.childSection === 'current',
				),
			).to.equal(true);
			expect(byCourse(result)).to.deep.equal(byCourse(reordered));
		}
	});

	it('preserves the combined lesson header and leaves unheaded attendance columns unlabelled', () => {
		const result = parsePortalResource(
			'lessons',
			'<div id="mappen"><table><thead><tr><th>Name</th><th>Thema Datum<br>/ Inhalt (wenn hinterlegt)<br>/ Hausaufgaben (wenn hinterlegt)</th><th>Weiteres</th></tr></thead><tbody><tr class="printable"><td>Synthetic name</td><td>Synthetic combined details</td><td>Synthetic note</td></tr></tbody></table></div><table id="attendanceTable"><tbody><tr><td>Synthetic attendance field</td><td>Synthetic attendance field two</td></tr></tbody></table>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const current = result.records.find(record => record.format === 'html' && record.section === 'mappen');
			const attendance = result.records.find(
				record => record.format === 'html' && record.section === 'attendanceTable',
			);
			expect(current?.format === 'html' && current.fields.map(field => field.header)).to.deep.equal([
				'Name',
				'Thema Datum\n/ Inhalt (wenn hinterlegt)\n/ Hausaufgaben (wenn hinterlegt)',
				'Weiteres',
			]);
			expect(attendance?.format === 'html' && attendance.fields.map(field => field.header)).to.deep.equal([
				null,
				null,
			]);
		}
	});

	it('excludes hidden portal encoding tokens and keeps attendance headers readable', () => {
		const result = parsePortalResource(
			'lessons',
			'<div id="attendanceTable"><table><thead><tr><th>Kurs</th><th>Lehrkraft</th><th>andere schulische Veranstaltung</th><th>anwesend</th><th>entschuldigt</th></tr></thead><tbody><tr><td>Englisch 05c</td><td>LIE</td><td><div class="hidden hidden_encoded">0902797c0b32a10cd9dea36476f503ac</div></td><td><div class="hidden hidden_encoded">10a278681a5b0dd93ebbb75af268cbe6</div>44</td><td><div class="hidden hidden_encoded">2b20ed715a6dee0571e419753ded35d7</div></td></tr></tbody></table></div>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const record = result.records[0];
			expect(record?.format).to.equal('html');
			if (record?.format === 'html') {
				expect(record.fields.map(field => field.header)).to.deep.equal([
					'Kurs',
					'Lehrkraft',
					'andere schulische Veranstaltung',
					'anwesend',
					'entschuldigt',
				]);
				expect(record.fields.map(field => field.text)).to.deep.equal(['Englisch 05c', 'LIE', '', '44', '']);
				expect(JSON.stringify(record.fields)).not.to.match(
					/0902797c0b32a10cd9dea36476f503ac|10a278681a5b0dd93ebbb75af268cbe6|2b20ed715a6dee0571e419753ded35d7/iu,
				);
			}
		}
	});

	it('classifies only nested child panes with confirmed tables and omits table-less panes', () => {
		const result = parsePortalResource(
			'lessons',
			'<a data-toggle="tab" href="#p17">Learner</a><div class="tab-pane" id="p17"><ul><li><a data-toggle="tab" href="#aktuell17">Current</a></li><li><a data-toggle="tab" href="#mappen17">Folders</a></li><li><a data-toggle="tab" href="#anwesend17">Attendance</a></li></ul><div class="tab-content"><div class="tab-pane active" id="aktuell17"><table><thead><tr><th>Entry</th></tr></thead><tbody><tr><td>Current item</td></tr></tbody></table></div><div class="tab-pane" id="mappen17"></div><div class="tab-pane" id="anwesend17"><table><thead><tr><th>Attendance</th></tr></thead><tbody><tr><td>Present</td></tr></tbody></table></div></div></div>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.children?.map(child => child.name)).to.deep.equal(['Learner']);
			expect(result.children?.[0]?.sections).to.deep.equal(['current', 'attendance']);
			expect(result.children?.[0]?.records).to.have.length(2);
			expect(
				result.children?.[0]?.records.map(record => record.format === 'html' && record.childSection),
			).to.deep.equal(['current', 'attendance']);
			expect(
				result.children?.[0]?.records.every(
					record => record.format === 'html' && record.section === 'child-lessons',
				),
			).to.equal(true);
			expect(result.groups.map(group => group.section)).to.deep.equal(['child-lessons', 'child-lessons']);
		}
	});

	it('classifies all verified canonical child sections, including a confirmed empty table', () => {
		const result = parsePortalResource(
			'lessons',
			'<a data-toggle="tab" href="#p17">Learner</a><div class="tab-pane" id="p17"><ul><li><a data-toggle="tab" href="#aktuell17">Current</a></li><li><a data-toggle="tab" href="#mappen17">Folders</a></li><li><a data-toggle="tab" href="#anwesend17">Attendance</a></li></ul><div class="tab-content"><div class="tab-pane" id="aktuell17"><table><thead><tr><th>Entry</th></tr></thead><tbody><tr><td>Current item</td></tr></tbody></table></div><div class="tab-pane" id="mappen17"><table><thead><tr><th>Assignment</th></tr></thead><tbody></tbody></table></div><div class="tab-pane" id="anwesend17"><table><thead><tr><th>Attendance</th></tr></thead><tbody><tr><td>Present</td></tr></tbody></table></div></div></div>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const child = result.children?.[0];
			expect(child?.sections).to.deep.equal(['current', 'assignments', 'attendance']);
			expect(child?.records.map(record => record.format === 'html' && record.childSection)).to.deep.equal([
				'current',
				'attendance',
			]);
			expect(
				child?.records.every(record => record.format === 'html' && record.section === 'child-lessons'),
			).to.equal(true);
			expect(result.groups.map(group => group.section)).to.deep.equal([
				'child-lessons',
				'child-lessons',
				'child-lessons',
			]);
			expect(result.groups[1]?.recordIds).to.deep.equal([]);
		}
	});

	it('retains unknown verified child panes in the aggregate as other without exposing IDs', () => {
		const result = parsePortalResource(
			'lessons',
			'<a data-toggle="tab" href="#p17">Learner Delta</a><div class="tab-pane" id="p17"><ul><li><a data-toggle="tab" href="#remarks17">Remarks</a></li></ul><div class="tab-content"><div class="tab-pane" id="remarks17"><table><thead><tr><th>Remark</th></tr></thead><tbody><tr><td>Retained entry</td></tr></tbody></table></div></div></div>',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const record = result.children?.[0]?.records[0];
			expect(result.records).to.have.length(1);
			expect(result.children?.[0]?.sections).to.deep.equal(['other']);
			expect(record).to.include({ section: 'child-lessons', childSection: 'other' });
			expect(record?.id).to.match(/^(?:source|hash):[a-f0-9]{64}$/u);
			expect(record?.id).not.to.match(/p17|remarks17|Learner Delta/u);
		}
	});

	it('retains metadata for empty but valid parent panels and hashes only the panel identifier', () => {
		const empty = parsePortalResource(
			'lessons',
			'<a data-toggle="tab" href="#p31">Learner Gamma</a><a data-toggle="tab" href="#p47">Learner Delta</a><div class="tab-pane" id="p31"><table><thead><tr><th>Item</th></tr></thead><tbody></tbody></table></div><div class="tab-pane" id="p47"><table><thead><tr><th>Item</th></tr></thead><tbody></tbody></table></div>',
		);
		const relabeled = parsePortalResource(
			'lessons',
			'<a data-toggle="tab" href="#p31">Renamed Learner</a><div class="tab-pane" id="p31"><table><thead><tr><th>Item</th></tr></thead><tbody></tbody></table></div>',
		);

		expect(empty.status).to.equal('complete');
		expect(relabeled.status).to.equal('complete');
		if (empty.status === 'complete' && relabeled.status === 'complete') {
			expect(empty.children?.map(child => child.records)).to.deep.equal([[], []]);
			expect(empty.children?.map(child => child.sections)).to.deep.equal([['other'], ['other']]);
			expect(empty.children?.[0]?.id).to.match(/^[a-f0-9]{64}$/u);
			expect(empty.children?.[0]?.id).to.equal(relabeled.children?.[0]?.id);
			expect(JSON.stringify(empty)).not.to.match(/p31|p47/u);
		}
	});

	it('rejects malformed parent tabs or missing and duplicate panels without falling back to page tables', () => {
		for (const body of [
			'<a data-toggle="tab" href="#p17">Learner Alpha</a><table><tr><th>Outside</th></tr><tr><td>Ignored</td></tr></table>',
			'<a data-toggle="tab" href="#p17"></a><div class="tab-pane" id="p17"></div>',
			'<a data-toggle="tab" href="#p17">Learner Alpha</a><div class="tab-pane" id="p17"></div><div class="tab-pane" id="p17"></div>',
			'<a data-toggle="tab" href="#pnotnumeric">Learner Alpha</a><div class="tab-pane" id="pnotnumeric"></div>',
			'<a data-toggle="tab" href="#p17">Learner Alpha</a><div id="p17"><table><tr><th>Item</th></tr><tr><td>Unverified</td></tr></table></div>',
			'<a data-toggle="tab" href="#p17">Learner Alpha</a><div class="tab-pane" id="p17"></div>',
		]) {
			expect(parsePortalResource('lessons', body)).to.deep.equal({
				status: 'invalid',
				kind: 'lessons',
				reason: 'lessons-tabs-invalid',
			});
		}
	});

	it('does not treat generic hash links as verified parent tabs', () => {
		const result = parsePortalResource(
			'lessons',
			'<a href="#p17">Learner Alpha</a><div id="p17"><table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>Unverified</td></tr></tbody></table></div>',
		);

		expect(result).to.deep.equal({
			status: 'invalid',
			kind: 'lessons',
			reason: 'lessons-sections-missing-with-tables',
		});
	});

	it('rejects parent lesson pages above the child-tab limit', () => {
		const body = Array.from({ length: 21 }, (_, index) => {
			const id = String(index + 1);
			return `<a data-toggle="tab" href="#p${id}">Child ${id}</a><div class="tab-pane" id="p${id}"><table><thead><tr><th>Item</th></tr></thead><tbody></tbody></table></div>`;
		}).join('');

		expect(parsePortalResource('lessons', body)).to.deep.equal({
			status: 'invalid',
			kind: 'lessons',
			reason: 'lessons-tabs-invalid',
		});
	});

	it('parses only the verified lesson detail sections', () => {
		const result = parsePortalResource(
			'lessons',
			'<table id="attendanceTable"><thead><tr><th>Date</th></tr></thead><tbody><tr><td>07.05.2026</td></tr></tbody></table><div id="marks"><table><tr><th>Mark</th></tr><tr><td>A</td></tr></table></div>',
		);
		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.groups.map(group => group.section)).to.deep.equal(['attendanceTable', 'marks']);
			expect(result.records).to.have.length(2);
		}
	});

	it('retains JSON record fields and source date/time strings without interpretation', () => {
		const fields = {
			event_id: 'evt-3',
			starts_at: '2026-05-07T08:15:00+02:00',
			title: 'Assessment',
			metadata: { room: 'B12', flags: ['scheduled'] },
		};
		const result = parsePortalResource('calendar', JSON.stringify([fields]), 'application/json');
		const reordered = parsePortalResource(
			'calendar',
			JSON.stringify([
				{
					metadata: { flags: ['scheduled'], room: 'B12' },
					title: '  Assessment  ',
					starts_at: fields.starts_at,
					event_id: 'evt-3',
				},
			]),
			'application/json',
		);

		expect(result.status).to.equal('complete');
		expect(reordered.status).to.equal('complete');
		if (result.status === 'complete' && reordered.status === 'complete') {
			expect(result.records[0].format).to.equal('json');
			if (result.records[0].format === 'json') {
				expect(result.records[0].fields).to.deep.equal(fields);
			}
			expect(result.records[0].id).to.match(/^source:[a-f0-9]{64}$/u);
			expect(result.records[0].id).to.equal(reordered.records[0].id);
			expect(result.groups).to.deep.equal([]);
		}
	});

	it('hashes case-insensitive source ID aliases without exposing them in record IDs', () => {
		const fields = {
			Id: 27,
			FremdUID: 'portal-event-5',
			Anfang: '2026-11-11T09:00:00+01:00',
			Geheim: false,
			Oeffentlich: true,
			Ort: 'Room 3',
		};
		const first = parsePortalResource('calendar', JSON.stringify([fields]), 'application/json');
		const reordered = parsePortalResource(
			'calendar',
			JSON.stringify([
				{
					Ort: 'Room 3',
					Oeffentlich: true,
					Geheim: false,
					Anfang: fields.Anfang,
					FremdUID: fields.FremdUID,
					Id: 27,
				},
			]),
			'application/json',
		);

		expect(first.status).to.equal('complete');
		expect(reordered.status).to.equal('complete');
		if (first.status === 'complete' && reordered.status === 'complete') {
			expect(first.records[0].id).to.match(/^source:[a-f0-9]{64}$/u);
			expect(first.records[0].id).to.equal(reordered.records[0].id);
			expect(first.records[0].id).not.to.contain('portal-event-5');
			expect(first.records[0].format === 'json' && first.records[0].fields).to.deep.equal(fields);
		}
	});

	it('parses quoted school-calendar CSV fields, aliases, BOM, and CRLF records', () => {
		const csv = [
			'\uFEFFStart,End,All Day,Title,Description,Place,Category,Responsible,UID',
			'2026-11-11T09:00:00+01:00,2026-11-11T10:00:00+01:00,false,"Meeting, ""Final""","Line 1,\r\nLine 2",Room 2,Exam,Jane Doe,event-1',
		].join('\r\n');
		const result = parsePortalResource('school-calendar', csv, 'text/csv; charset=utf-8');
		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.records).to.have.length(1);
			const record = result.records[0];
			expect(record.format).to.equal('json');
			if (record.format === 'json') {
				expect(record.fields).to.deep.equal({
					start: '2026-11-11T09:00:00+01:00',
					end: '2026-11-11T10:00:00+01:00',
					all_day: false,
					summary: 'Meeting, "Final"',
					description: 'Line 1,\r\nLine 2',
					location: 'Room 2',
					category: 'Exam',
					responsible: 'Jane Doe',
					uid: 'event-1',
				});
				expect(record.id).to.match(/^source:[a-f0-9]{64}$/u);
				expect(record.id).not.to.contain('event-1');
			}
		}
	});

	it('keeps school-calendar CSV rows with missing dates for per-event filtering', () => {
		const result = parsePortalResource(
			'school-calendar',
			'Start,End,Title\r\n,2026-11-12,Undated\r\n2026-11-13,2026-11-13,Future event',
			'text/csv',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.records).to.have.length(2);
			expect(result.records[0]?.format === 'json' && result.records[0].fields).to.include({ start: '' });
		}
	});

	it('parses folded iCalendar values, escaped text, TZIDs, and DATE types without conversion', () => {
		const body = [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'BEGIN:VEVENT',
			'UID:ics-event-1',
			'DTSTART;TZID=Europe/Berlin:20261111T090000',
			'DTEND;TZID=Europe/Berlin:20261111T100000',
			'SUMMARY:Staff team meet',
			' ing',
			'DESCRIPTION:First\\nSecond\\, line\\; detail\\\\end',
			'LOCATION:Room 4',
			'CATEGORIES:Teaching\\, staff,Term',
			'ORGANIZER;CN="Jane Doe":mailto:jane@example.org',
			'END:VEVENT',
			'END:VCALENDAR',
		].join('\r\n');
		const result = parsePortalResource('school-calendar', body);
		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			const record = result.records[0];
			expect(record.format).to.equal('json');
			if (record.format === 'json') {
				expect(record.fields).to.deep.equal({
					start: '20261111T090000',
					start_type: 'DATE-TIME',
					all_day: false,
					start_tzid: 'Europe/Berlin',
					end: '20261111T100000',
					end_type: 'DATE-TIME',
					end_tzid: 'Europe/Berlin',
					summary: 'Staff team meeting',
					description: 'First\nSecond, line; detail\\end',
					location: 'Room 4',
					uid: 'ics-event-1',
					category: 'Teaching, staff,Term',
					responsible: 'Jane Doe',
				});
				expect(record.id).to.match(/^source:[a-f0-9]{64}$/u);
			}
		}

		const allDay = parsePortalResource(
			'school-calendar',
			'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:date-1\r\nDTSTART;VALUE=DATE:20261111\r\nDTEND;VALUE=DATE:20261112\r\nEND:VEVENT\r\nEND:VCALENDAR',
			'text/calendar',
		);
		expect(allDay.status).to.equal('complete');
		if (allDay.status === 'complete' && allDay.records[0].format === 'json') {
			expect(allDay.records[0].fields).to.include({
				start: '20261111',
				start_type: 'DATE',
				end: '20261112',
				end_type: 'DATE',
				all_day: true,
			});
		}
	});

	it('rejects malformed exports and duplicate source IDs instead of confirming empty data', () => {
		const malformedCsv = parsePortalResource('school-calendar', 'start,end,summary\r\n"open,unclosed', 'text/csv');
		const malformedIcal = parsePortalResource(
			'school-calendar',
			'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261111T090000\r\nEND:VCALENDAR',
			'text/calendar',
		);
		const duplicateJson = parsePortalResource(
			'calendar',
			JSON.stringify([
				{ Id: 9, title: 'One' },
				{ id: 9, title: 'Two' },
			]),
			'application/json',
		);
		expect(malformedCsv).to.deep.equal({ status: 'invalid', kind: 'school-calendar', reason: 'malformed-csv' });
		expect(malformedIcal).to.deep.equal({
			status: 'invalid',
			kind: 'school-calendar',
			reason: 'malformed-icalendar',
		});
		expect(duplicateJson).to.deep.equal({
			status: 'invalid',
			kind: 'calendar',
			reason: 'invalid-json-records',
		});
		expect(malformedCsv).not.to.have.property('records');
	});

	it('accepts confirmed substitution dates and preserves their original portal tags', () => {
		const dates = parsePortalResource(
			'substitution-dates',
			'<html><body><button data-tag="01.09.2026">Tuesday</button><button data-tag="02.09.2026">Wednesday</button><button data-tag="12_11_2026">Thursday</button></body></html>',
			'text/html',
		);
		expect(dates.status).to.equal('complete');
		if (dates.status === 'complete') {
			expect(dates.records.map(record => record.format === 'json' && record.fields.date)).to.deep.equal([
				'01.09.2026',
				'02.09.2026',
				'12.11.2026',
			]);
			expect(dates.records.map(record => record.format === 'json' && record.fields.portalTag)).to.deep.equal([
				'01.09.2026',
				'02.09.2026',
				'12_11_2026',
			]);
			expect(dates.records[0].id).to.match(/^source:[a-f0-9]{64}$/u);
			expect(dates.records[0].id).not.to.contain('01.09.2026');
		}
		expect(parsePortalResource('substitution-dates', '<p>No dated entries</p>', 'text/html')).to.deep.equal({
			status: 'unavailable',
			kind: 'substitution-dates',
			reason: 'unsupported-html-structure',
		});
		for (const date of ['31.02.2026', '31_02_2026', '12_11.2026']) {
			expect(
				parsePortalResource('substitution-dates', `<button data-tag="${date}">bad</button>`, 'text/html'),
			).to.deep.equal({
				status: 'invalid',
				kind: 'substitution-dates',
				reason: 'unexpected-html-structure',
			});
		}
	});

	it('parses visible own-plan rows only from date-matched substitution tables', () => {
		const headers = ['', 'Stunde', 'Klasse', 'Vertretung', 'Lehrkraft', 'Fach', 'Raum', 'Hinweis'];
		const renderTable = (date: string, rows: readonly (readonly string[])[]): string =>
			`<table id="vtable${date}"><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows
				.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`)
				.join('')}</tbody></table>`;
		const rows12 = [
			['', '1', '5a', 'Coverage A', 'Teacher A', 'Math', '101', 'Room change'],
			['', '2', '5b', 'Coverage B', 'Teacher B', 'German', '102', ''],
			['', '3', '6a', 'Coverage C', 'Teacher C', 'English', '103', ''],
			['', '4', '6b', 'Coverage D', 'Teacher D', 'Science', '104', ''],
		];
		const rows13 = [
			['', '1', '7a', 'Coverage E', 'Teacher E', 'History', '201', ''],
			['', '2', '7b', 'Coverage F', 'Teacher F', 'Art', '202', ''],
			['', '3', '8a', 'Coverage G', 'Teacher G', 'Music', '203', ''],
		];
		const body = `<html><body><button data-tag="12_11_2026">12 November</button><button data-tag="13_11_2026">13 November</button>${renderTable('12_11_2026', rows12)}${renderTable('13_11_2026', rows13)}</body></html>`;

		const result = parsePortalResource('substitutions', body, 'text/html');

		expect(result.status).to.equal('complete');
		if (result.status !== 'complete') {
			return;
		}
		expect(result.records).to.have.length(7);
		expect(result.groups).to.deep.equal([]);
		const records = result.records.filter(record => record.format === 'json');
		expect(records).to.have.length(7);
		expect(records.filter(record => record.fields.portalDate === '12.11.2026')).to.have.length(4);
		expect(records.filter(record => record.fields.portalDate === '13.11.2026')).to.have.length(3);
		expect(records[0]?.fields).to.deep.equal({
			portalDate: '12.11.2026',
			columns: headers.map((header, index) => ({ header, value: rows12[0]?.[index] ?? '' })),
		});
	});

	it('does not parse own-plan listings above the existing date limit', () => {
		const headers = ['', 'Stunde', 'Klasse', 'Vertretung', 'Lehrkraft', 'Fach', 'Raum', 'Hinweis'];
		const headerRow = `<thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead>`;
		const dates = Array.from({ length: 32 }, (_, index) => {
			const date = new Date(Date.UTC(2026, 0, index + 1));
			const day = String(date.getUTCDate()).padStart(2, '0');
			const month = String(date.getUTCMonth() + 1).padStart(2, '0');
			return `${day}_${month}_${date.getUTCFullYear()}`;
		});
		const body = dates
			.map(
				date =>
					`<button data-tag="${date}"></button><table id="vtable${date}">${headerRow}<tbody></tbody></table>`,
			)
			.join('');

		expect(parsePortalResource('substitutions', body, 'text/html')).to.deep.equal({
			status: 'unavailable',
			kind: 'substitutions',
			reason: 'unsupported-html-structure',
		});
	});

	it('keeps substitution record IDs stable when table rows are reordered', () => {
		const headers = ['', 'Stunde', 'Klasse', 'Vertretung', 'Lehrkraft', 'Fach', 'Raum', 'Hinweis'];
		const rows = [
			['', '1', '5a', 'Coverage A', 'Teacher A', 'Math', '101', ''],
			['', '2', '5b', 'Coverage B', 'Teacher B', 'English', '102', ''],
		];
		const parseIds = (tableRows: readonly (readonly string[])[]): string[] => {
			const table = `<button data-tag="12_11_2026"></button><table id="vtable12_11_2026"><thead><tr>${headers
				.map(header => `<th>${header}</th>`)
				.join('')}</tr></thead><tbody>${tableRows
				.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`)
				.join('')}</tbody></table>`;
			const result = parsePortalResource('substitutions', table, 'text/html');
			expect(result.status).to.equal('complete');
			return result.status === 'complete' ? result.records.map(record => record.id).sort() : [];
		};

		expect(parseIds(rows)).to.deep.equal(parseIds([...rows].reverse()));
	});

	it('rejects missing or mismatched substitution tables and headers without losing rows', () => {
		const headers = ['', 'Stunde', 'Klasse', 'Vertretung', 'Lehrkraft', 'Fach', 'Raum', 'Hinweis'];
		const headerCells = headers.map(header => `<th>${header}</th>`).join('');
		const row =
			'<tr><td></td><td>1</td><td>5a</td><td>Coverage</td><td>Teacher</td><td>Math</td><td>101</td><td></td></tr>';
		const tag = '<button data-tag="12_11_2026">12 November</button>';
		const makeTable = (id: string, header = headerCells, data = row): string =>
			`<table id="${id}"><thead><tr>${header}</tr></thead><tbody>${data}</tbody></table>`;

		expect(parsePortalResource('substitutions', tag, 'text/html')).to.deep.equal({
			status: 'unavailable',
			kind: 'substitutions',
			reason: 'unsupported-html-structure',
		});
		for (const body of [
			`${tag}${makeTable('vtable13_11_2026')}`,
			`${tag}${makeTable('vtable12_11_2026', headerCells.replace('<th>Hinweis</th>', '<th>Notiz</th>'))}`,
			`${tag}${makeTable('vtable12_11_2026', headerCells, '<tr><td>Incomplete row</td></tr>')}`,
		]) {
			expect(parsePortalResource('substitutions', body, 'text/html')).to.deep.equal({
				status: 'invalid',
				kind: 'substitutions',
				reason: 'unexpected-html-structure',
			});
		}
		expect(
			parsePortalResource(
				'substitutions',
				`${tag}<button class="btn-ganzerplan">Full plan</button>${makeTable('vtable12_11_2026')}`,
				'text/html',
			),
		).to.deep.equal({
			status: 'unavailable',
			kind: 'substitutions',
			reason: 'unsupported-html-structure',
		});
	});

	it('keeps zero substitution responses unavailable and rejects non-sentinel numbers', () => {
		expect(parsePortalResource('substitutions', '0', 'text/html')).to.deep.equal({
			status: 'unavailable',
			kind: 'substitutions',
			reason: 'unsupported-html-structure',
		});
		for (const body of ['0', '1']) {
			expect(parsePortalResource('substitutions', body, 'application/json')).to.deep.equal({
				status: 'unavailable',
				kind: 'substitutions',
				reason: 'unrecognized-json-structure',
			});
		}
		expect(parsePortalResource('substitutions', '1', 'text/html').status).not.to.equal('complete');
		expect(parsePortalResource('substitution-dates', '0', 'text/html').status).not.to.equal('complete');
	});

	it('keeps verified inbox details while stripping markup and unknown source properties', () => {
		const replyId = 'a'.repeat(64);
		const result = parsePortalResource(
			'messages',
			JSON.stringify([
				{
					id: 'message-1',
					subject: 'School update',
					senderShortName: 'A. Teacher',
					senderName: 'Alex Teacher',
					date: '11.11.2026',
					unread: true,
					hidden: false,
					username: '<b>Alex Teacher</b>',
					own: false,
					content: '<p>Hello <strong>there</strong><script>private-script</script></p>',
					replies: [
						{
							id: replyId,
							date: '12.11.2026',
							username: 'Student',
							own: true,
							content: 'A reply',
						},
					],
					body: 'unknown field must not be exposed',
					senderId: 'raw-sender-id',
				},
			]),
			'application/json',
		);
		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.records[0].format === 'json' && result.records[0].fields).to.deep.equal({
				id: 'message-1',
				subject: 'School update',
				senderShortName: 'A. Teacher',
				senderName: 'Alex Teacher',
				date: '11.11.2026',
				unread: true,
				hidden: false,
				username: 'Alex Teacher',
				own: false,
				content: 'Hello there',
				replies: [{ id: replyId, date: '12.11.2026', username: 'Student', own: true, content: 'A reply' }],
			});
			expect(result.records[0].id).to.match(/^source:[a-f0-9]{64}$/u);
			expect(JSON.stringify(result)).not.to.match(/private-script|unknown field|raw-sender-id/u);
		}
		expect(parsePortalResource('messages', '[]', 'application/json').status).to.equal('complete');
	});

	it('parses only the verified account profile table and account-type icon markers', () => {
		const result = parsePortalResource(
			'account',
			'<div class="nav navbar-nav navbar-right"><li><a><i class="fa fa-child"></i></a></li></div><div class="col-md-12"><table class="table table-striped"><tbody><tr><td>Display name</td><td>Student Name</td></tr><tr><td>Authentication token</td><td>private-token</td></tr><tr><td>Kennwort</td><td>private-password</td></tr><tr><td>School</td><td>School text</td></tr></tbody></table></div>',
			'text/html',
		);
		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.records.map(record => record.format === 'json' && record.fields)).to.deep.equal([
				{ recordType: 'profile', label: 'Display name', value: 'Student Name' },
				{ recordType: 'profile', label: 'School', value: 'School text' },
				{ recordType: 'account-type', type: 'student' },
			]);
			expect(JSON.stringify(result)).not.to.contain('private-token');
			expect(JSON.stringify(result)).not.to.contain('private-password');
			expect(JSON.stringify(result)).not.to.contain('schoolName');
		}
		expect(parsePortalResource('account', '<p>No profile table</p>', 'text/html')).to.deep.equal({
			status: 'unavailable',
			kind: 'account',
			reason: 'unsupported-html-structure',
		});
	});

	it('keeps valid empty exports complete but never converts malformed or unsupported exports to empty', () => {
		const emptyCsv = parsePortalResource('school-calendar', 'start,end,summary\r\n', 'text/csv');
		const emptyIcal = parsePortalResource('school-calendar', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR', 'text/calendar');
		const unsupportedEmptyJson = parsePortalResource('school-calendar', '[]', 'application/json');
		expect(emptyCsv.status === 'complete' && emptyCsv.records).to.have.length(0);
		expect(emptyIcal.status === 'complete' && emptyIcal.records).to.have.length(0);
		expect(unsupportedEmptyJson.status).to.equal('invalid');
		expect(unsupportedEmptyJson).not.to.have.property('records');
	});

	it('omits file URLs and preserves safe non-sensitive JSON metadata', () => {
		const result = parsePortalResource(
			'file-metadata',
			JSON.stringify([
				{
					id: 'file-7',
					name: 'Plan',
					path: '/dateispeicher.php/files',
					download_url: '/dateispeicher.php?s=private-session&file=7',
					external_url: 'https://external.example/file',
					session_id: 'private-session',
					cookie: 'sid=private-cookie',
					raw_html: '<table>private HTML</table>',
				},
			]),
			'application/json',
		);

		expect(result.status).to.equal('complete');
		if (result.status === 'complete') {
			expect(result.records[0]).to.deep.include({
				format: 'json',
				fields: { id: 'file-7', name: 'Plan' },
			});
			expect(result.records[0].fields).not.to.have.property('path');
			expect(result.records[0].fields).not.to.have.property('download_url');
			expect(result.records[0].id).to.match(/^source:[a-f0-9]{64}$/u);
			expect(JSON.stringify(result)).not.to.match(
				/private-session|private-cookie|external\.example|private HTML/u,
			);
		}
	});

	it('derives stable opaque file IDs from normalized content when no data-id exists', () => {
		const first = parsePortalResource(
			'file-metadata',
			'<table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody><tr><td>  My&nbsp;file  </td><td></td><td></td></tr><tr><td>Other file</td><td></td><td></td></tr></tbody></table>',
		);
		const reordered = parsePortalResource(
			'file-metadata',
			'<table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody><tr><td>Other file</td><td></td><td></td></tr><tr><td>My file</td><td></td><td></td></tr><tr><td>Added</td><td></td><td></td></tr></tbody></table>',
		);

		expect(first.status).to.equal('complete');
		expect(reordered.status).to.equal('complete');
		if (first.status === 'complete' && reordered.status === 'complete') {
			const firstFile = first.records.find(
				record =>
					record.format === 'json' &&
					typeof record.fields.name === 'string' &&
					record.fields.name.includes('My'),
			);
			const reorderedFile = reordered.records.find(
				record =>
					record.format === 'json' &&
					typeof record.fields.name === 'string' &&
					record.fields.name.includes('My'),
			);
			expect(firstFile?.id).to.equal(reorderedFile?.id);
			expect(first.records.map(record => record.id)).not.to.include('My file');
		}
	});

	it('accepts an expected empty table only when its header structure is present', () => {
		const empty = parsePortalResource(
			'file-metadata',
			'<table id="files"><thead><tr><th>Name</th><th>Änderung</th><th>Größe</th></tr></thead><tbody></tbody></table>',
		);
		const unstructured = parsePortalResource('file-metadata', '<table id="files"></table>');

		expect(empty.status).to.equal('complete');
		if (empty.status === 'complete') {
			expect(empty.records).to.deep.equal([]);
		}
		expect(unstructured).to.deep.equal({
			status: 'invalid',
			kind: 'file-metadata',
			reason: 'unexpected-html-structure',
		});
	});

	it('accepts empty JSON only for documented row-array resources and preserves invalid-vs-empty status', () => {
		for (const kind of ['calendar', 'substitutions', 'messages'] as const) {
			const empty = parsePortalResource(kind, '[]', 'application/json');
			expect(empty).to.deep.equal({ status: 'complete', kind, records: [], groups: [] });
		}
		expect(parsePortalResource('account', '[]', 'application/json')).to.deep.equal({
			status: 'unavailable',
			kind: 'account',
			reason: 'unrecognized-json-structure',
		});
		expect(parsePortalResource('substitutions', '0', 'application/json')).to.deep.equal({
			status: 'unavailable',
			kind: 'substitutions',
			reason: 'unrecognized-json-structure',
		});
		expect(parsePortalResource('calendar', '0', 'application/json').status).to.equal('unavailable');
		const malformed = parsePortalResource('calendar', '{', 'application/json');
		expect(malformed).to.deep.equal({ status: 'invalid', kind: 'calendar', reason: 'malformed-json' });
		expect(malformed).not.to.have.property('records');
		expect(parsePortalResource('timetable', '<html><body><p>Unknown page</p></body></html>')).to.deep.equal({
			status: 'invalid',
			kind: 'timetable',
			reason: 'timetable-sections-missing-no-tables',
		});
		expect(parsePortalResource('timetable', '<html><body><table></table></body></html>')).to.deep.equal({
			status: 'invalid',
			kind: 'timetable',
			reason: 'timetable-sections-missing-with-tables',
		});
		expect(parsePortalResource('timetable', '<html><body><div id="all"></div></body></html>')).to.deep.equal({
			status: 'invalid',
			kind: 'timetable',
			reason: 'timetable-tables-missing',
		});
		expect(parsePortalResource('lessons', '<html><body><table></table></body></html>')).to.deep.equal({
			status: 'invalid',
			kind: 'lessons',
			reason: 'lessons-sections-missing-with-tables',
		});
		expect(parsePortalResource('lessons', '<html><body><p>Unknown page</p></body></html>')).to.deep.equal({
			status: 'invalid',
			kind: 'lessons',
			reason: 'lessons-sections-missing-no-tables',
		});
		expect(parsePortalResource('lessons', '<html><body><div id="mappen"></div></body></html>')).to.deep.equal({
			status: 'invalid',
			kind: 'lessons',
			reason: 'lessons-tables-missing',
		});
		expect(
			parsePortalResource('lessons', '<html><body><div id="mappen"><table></table></div></body></html>'),
		).to.deep.equal({
			status: 'invalid',
			kind: 'lessons',
			reason: 'lessons-table-structure-invalid',
		});
		expect(parsePortalResource('timetable', '')).to.deep.equal({
			status: 'invalid',
			kind: 'timetable',
			reason: 'empty-response',
		});
	});

	it('classifies login, permission, and feature-unavailable responses without exposing page text', () => {
		expect(
			parsePortalResource(
				'account',
				'<form action="/login.php"><input name="user2"><input type="password" name="password"></form>',
			),
		).to.deep.equal({ status: 'unavailable', kind: 'account', reason: 'login-required' });
		expect(
			parsePortalResource(
				'timetable',
				'<html><body><h1>Login nötig</h1><p>Um auf das gewünschte Tool zuzugreifen, muss man eingeloggt sein.</p><table></table></body></html>',
			),
		).to.deep.equal({ status: 'unavailable', kind: 'timetable', reason: 'login-required' });
		expect(
			parsePortalResource('learning-groups', '<p>Sie haben keine Berechtigung für diese Ansicht.</p>'),
		).to.deep.equal({ status: 'unavailable', kind: 'learning-groups', reason: 'permission-denied' });
		expect(parsePortalResource('substitutions', '<p>Dieser Bereich ist nicht freigeschaltet.</p>')).to.deep.equal({
			status: 'unavailable',
			kind: 'substitutions',
			reason: 'feature-unavailable',
		});
	});

	it('rejects malformed HTML and JSON, and reports unsupported HTML layouts conservatively', () => {
		expect(parsePortalResource('timetable', '<table><tr><td>unfinished')).to.deep.equal({
			status: 'invalid',
			kind: 'timetable',
			reason: 'malformed-html',
		});
		expect(parsePortalResource('calendar', '{', 'application/json')).to.deep.equal({
			status: 'invalid',
			kind: 'calendar',
			reason: 'malformed-json',
		});
		expect(
			parsePortalResource('account', '<html><body><p>Account details</p></body></html>', 'text/html'),
		).to.deep.equal({ status: 'unavailable', kind: 'account', reason: 'unsupported-html-structure' });
	});
});
