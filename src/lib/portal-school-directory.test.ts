import { expect } from 'chai';
import {
	fetchSchoolOptions,
	parseSchoolDirectory,
	SchoolDirectoryError,
	searchSchoolOptions,
} from './portal-school-directory';

const sampleDirectory = [
	{
		Id: 'kreis-1',
		Schulen: [
			{ Id: '5202', Name: 'Beispiel-Schule', Ort: 'Beispielstadt' },
			{ Id: '5203', Name: 'Zweite Schule', Ort: 'Andersort' },
		],
	},
	{ Id: 'kreis-2', Schulen: [{ Id: '5202', Name: 'Duplikat', Ort: 'Andersort' }] },
];

async function expectSchoolDirectoryError(promise: Promise<unknown>): Promise<void> {
	let error: unknown;
	try {
		await promise;
	} catch (caught) {
		error = caught;
	}
	expect(error).to.be.instanceOf(SchoolDirectoryError);
}

describe('portal school directory', () => {
	it('flattens the official district structure into unique searchable options', () => {
		expect(parseSchoolDirectory(sampleDirectory)).to.deep.equal([
			{ value: '5202', label: 'Beispiel-Schule — Beispielstadt (5202)' },
			{ value: '5203', label: 'Zweite Schule — Andersort (5203)' },
		]);
	});

	it('returns explicit matching results, ranks an exact school ID, and bounds the list', () => {
		const options = [
			{ value: '5203', label: 'Beispiel-Schule — Beispielstadt (5203)' },
			{ value: '5202', label: 'Beispiel-Schule — Beispielstadt (5202)' },
			{ value: '5204', label: 'Andere Schule — Andersort (5204)' },
		];
		expect(searchSchoolOptions(options, 'beispiel schule')).to.deep.equal(options.slice(0, 2));
		expect(searchSchoolOptions(options, '5202')).to.deep.equal([options[1]]);
		expect(searchSchoolOptions(options, 'BEISPIELSTADT')).to.deep.equal(options.slice(0, 2));
		expect(
			searchSchoolOptions([{ value: '5205', label: 'Schule — Groß-Gerau (5205)' }], 'gross gerau'),
		).to.deep.equal([{ value: '5205', label: 'Schule — Groß-Gerau (5205)' }]);
		expect(searchSchoolOptions(options, 'a')).to.deep.equal([]);
		expect(searchSchoolOptions(options, 'x'.repeat(101))).to.deep.equal([]);
		expect(searchSchoolOptions(options, null)).to.deep.equal([]);
		const manyOptions = Array.from({ length: 75 }, (_, index) => ({
			value: String(1000 + index),
			label: `Beispiel-Schule ${index} — Beispielstadt (${1000 + index})`,
		}));
		expect(searchSchoolOptions(manyOptions, 'beispiel')).to.have.lengthOf(50);
	});

	it('fetches only the fixed public directory without sending account data', async () => {
		let requestedUrl = '';
		let request: RequestInit | undefined;
		const fetchImpl: typeof fetch = (input, init) => {
			requestedUrl = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
			request = init;
			return Promise.resolve(new Response(JSON.stringify(sampleDirectory), { status: 200 }));
		};

		const options = await fetchSchoolOptions(fetchImpl);

		expect(requestedUrl).to.equal('https://startcache.schulportal.hessen.de/exporteur.php?a=schoollist');
		expect(request?.method).to.equal('GET');
		expect(request?.redirect).to.equal('error');
		expect(new Headers(request?.headers).get('authorization')).to.equal(null);
		expect(new Headers(request?.headers).get('cookie')).to.equal(null);
		expect(options.map(option => option.value)).to.deep.equal(['5202', '5203']);
	});

	it('rejects malformed directory responses and HTTP failures', async () => {
		expect(() => parseSchoolDirectory({ schools: [] })).to.throw(SchoolDirectoryError);
		expect(() => parseSchoolDirectory([{ Schulen: 'invalid' }])).to.throw(SchoolDirectoryError);
		await expectSchoolDirectoryError(
			fetchSchoolOptions(() => Promise.resolve(new Response('unavailable', { status: 503 }))),
		);
		await expectSchoolDirectoryError(fetchSchoolOptions(() => Promise.resolve(new Response('{invalid json'))));
		await expectSchoolDirectoryError(
			fetchSchoolOptions(() => Promise.resolve(new Response(new Uint8Array(2 * 1024 * 1024 + 1)))),
		);
	});
});
