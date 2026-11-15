const MAX_SEGMENT_LENGTH = 64;
const EMPTY_LABEL_FALLBACK = 'unnamed';

interface IdPathSegmentEntry {
	sourceId: string;
	displayName: string;
}

interface NormalizedEntry {
	sourceId: string;
	baseSegment: string;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function toBaseSegment(displayName: string): string {
	const segment = displayName
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/ß/g, 'ss')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_SEGMENT_LENGTH)
		.replace(/-+$/g, '');

	return segment || EMPTY_LABEL_FALLBACK;
}

function addNumericSuffix(baseSegment: string, suffix: number): string {
	const suffixText = `-${suffix}`;
	const prefix = baseSegment.slice(0, MAX_SEGMENT_LENGTH - suffixText.length).replace(/-+$/g, '');
	return prefix ? `${prefix}${suffixText}` : String(suffix);
}

/**
 * Allocate stable, readable ioBroker path segments for display names.
 *
 * Colliding names are ordered by sourceId, which is used only for allocation order and is never included in a segment.
 *
 * @param entries Source IDs paired with their display names.
 */
export function allocateIdPathSegments(entries: readonly IdPathSegmentEntry[]): Map<string, string> {
	if (!Array.isArray(entries)) {
		throw new TypeError('entries must be an array');
	}

	const sourceIds = new Set<string>();
	const normalizedEntries = entries.map(entry => {
		if (!entry || typeof entry !== 'object') {
			throw new TypeError('each entry must be an object');
		}
		if (typeof entry.sourceId !== 'string' || entry.sourceId.trim().length === 0) {
			throw new TypeError('sourceId must be a non-empty string');
		}
		if (sourceIds.has(entry.sourceId)) {
			throw new Error('sourceId values must be unique');
		}
		if (typeof entry.displayName !== 'string') {
			throw new TypeError('displayName must be a string');
		}

		sourceIds.add(entry.sourceId);
		return { sourceId: entry.sourceId, baseSegment: toBaseSegment(entry.displayName) };
	});

	normalizedEntries.sort((left, right) => compareStrings(left.sourceId, right.sourceId));

	const groups = new Map<string, NormalizedEntry[]>();
	for (const entry of normalizedEntries) {
		const group = groups.get(entry.baseSegment);
		if (group) {
			group.push(entry);
		} else {
			groups.set(entry.baseSegment, [entry]);
		}
	}

	const usedSegments = new Set(groups.keys());
	const allocatedEntries: { sourceId: string; segment: string }[] = [];
	for (const baseSegment of [...groups.keys()].sort(compareStrings)) {
		const group = groups.get(baseSegment)!;
		allocatedEntries.push({ sourceId: group[0].sourceId, segment: baseSegment });

		let suffix = 2;
		for (let index = 1; index < group.length; index++) {
			let segment = addNumericSuffix(baseSegment, suffix);
			while (usedSegments.has(segment)) {
				segment = addNumericSuffix(baseSegment, ++suffix);
			}
			usedSegments.add(segment);
			allocatedEntries.push({ sourceId: group[index].sourceId, segment });
			suffix++;
		}
	}

	allocatedEntries.sort((left, right) => compareStrings(left.sourceId, right.sourceId));
	return new Map(allocatedEntries.map(({ sourceId, segment }) => [sourceId, segment]));
}
