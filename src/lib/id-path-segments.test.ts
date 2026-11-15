import { expect } from 'chai';
import { allocateIdPathSegments } from './id-path-segments';

describe('allocateIdPathSegments', () => {
	it('normalizes diacritics and replaces punctuation with safe separators', () => {
		const segments = allocateIdPathSegments([{ sourceId: 'student-1', displayName: "École d'été / 4. Klasse" }]);

		expect(segments.get('student-1')).to.equal('ecole-d-ete-4-klasse');
		expect(segments.get('student-1')).to.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	});

	it('uses a fallback for empty labels and still makes fallback segments unique', () => {
		const segments = allocateIdPathSegments([
			{ sourceId: 'empty', displayName: '' },
			{ sourceId: 'punctuation', displayName: '?!' },
			{ sourceId: 'spaces', displayName: ' \t\n' },
		]);

		expect(segments.get('empty')).to.equal('unnamed');
		expect(segments.get('punctuation')).to.equal('unnamed-2');
		expect(segments.get('spaces')).to.equal('unnamed-3');
	});

	it('adds deterministic numeric suffixes for duplicate and naturally colliding slugs', () => {
		const segments = allocateIdPathSegments([
			{ sourceId: 'child-b', displayName: 'Mädchen' },
			{ sourceId: 'child-a', displayName: 'Mädchen' },
			{ sourceId: 'child-c', displayName: 'Mädchen-2' },
			{ sourceId: 'child-d', displayName: 'Mädchen' },
		]);

		expect(segments.get('child-a')).to.equal('madchen');
		expect(segments.get('child-b')).to.equal('madchen-3');
		expect(segments.get('child-c')).to.equal('madchen-2');
		expect(segments.get('child-d')).to.equal('madchen-4');
	});

	it('returns the same assignments regardless of input ordering', () => {
		const entries = [
			{ sourceId: 'source-z', displayName: 'Same label' },
			{ sourceId: 'source-a', displayName: 'Same label' },
			{ sourceId: 'source-m', displayName: 'Same label' },
			{ sourceId: 'source-b', displayName: 'Same-label' },
		];

		expect(allocateIdPathSegments(entries)).to.deep.equal(allocateIdPathSegments([...entries].reverse()));
	});

	it('bounds every segment and rejects invalid or duplicate source IDs', () => {
		const longSegments = allocateIdPathSegments([
			{ sourceId: 'long-a', displayName: 'Long name '.repeat(20) },
			{ sourceId: 'long-b', displayName: 'Long name '.repeat(20) },
		]);
		for (const segment of longSegments.values()) {
			expect(segment.length).to.be.at.most(64);
			expect(segment).to.match(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		}

		expect(() => allocateIdPathSegments([{ sourceId: '', displayName: 'Name' }])).to.throw(TypeError);
		expect(() => allocateIdPathSegments([{ sourceId: '  ', displayName: 'Name' }])).to.throw(TypeError);
		expect(() =>
			allocateIdPathSegments([
				{ sourceId: 1, displayName: 'Name' } as unknown as { sourceId: string; displayName: string },
			]),
		).to.throw(TypeError);
		expect(() =>
			allocateIdPathSegments([
				{ sourceId: 'same', displayName: 'First' },
				{ sourceId: 'same', displayName: 'Second' },
			]),
		).to.throw('sourceId values must be unique');
	});
});
