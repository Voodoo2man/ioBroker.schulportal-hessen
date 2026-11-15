const SCHOOL_DIRECTORY_URL = new URL('https://startcache.schulportal.hessen.de/exporteur.php?a=schoollist');
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCHOOL_COUNT = 10_000;
const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 100;
const MAX_SEARCH_RESULTS = 50;

/** Search option returned to the Admin school selector. */
export interface SchoolOption {
	/** Numeric school identifier stored in the adapter configuration. */
	value: string;
	/** Human-readable school name, town, and identifier. */
	label: string;
}

/** Safe failure raised when the public directory is unavailable or malformed. */
export class SchoolDirectoryError extends Error {
	/** Create a generic directory error without transport details. */
	constructor() {
		super('The public school directory could not be loaded.');
		this.name = 'SchoolDirectoryError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanLabelPart(value: unknown): string {
	return typeof value === 'string'
		? value
				.replace(/\p{Cc}/gu, ' ')
				.replace(/\s+/g, ' ')
				.trim()
		: '';
}

function schoolId(value: unknown): string | undefined {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		value = String(value);
	}
	return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : undefined;
}

/**
 * Parse and normalize the public directory without returning malformed school IDs.
 *
 * @param payload Untrusted decoded directory data.
 * @returns Searchable school options.
 */
export function parseSchoolDirectory(payload: unknown): SchoolOption[] {
	if (!Array.isArray(payload) || payload.length > 100) {
		throw new SchoolDirectoryError();
	}

	const schools = new Map<string, string>();
	for (const district of payload) {
		if (!isRecord(district) || !Array.isArray(district.Schulen)) {
			throw new SchoolDirectoryError();
		}
		for (const school of district.Schulen) {
			if (!isRecord(school)) {
				throw new SchoolDirectoryError();
			}
			const id = schoolId(school.Id);
			const name = cleanLabelPart(school.Name);
			const town = cleanLabelPart(school.Ort);
			if (!id || !name) {
				continue;
			}
			if (!schools.has(id)) {
				schools.set(id, `${name}${town ? ` — ${town}` : ''} (${id})`);
			}
			if (schools.size > MAX_SCHOOL_COUNT) {
				throw new SchoolDirectoryError();
			}
		}
	}

	return [...schools].map(([value, label]) => ({ value, label }));
}

function normalizeSearchText(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase('de')
		.replace(/ß/g, 'ss')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * Filter directory options for an explicit Admin selection, with a bounded result list.
 *
 * @param options Complete public directory options.
 * @param query Search text from the Admin form.
 * @returns At most 50 matching options, ranked by exact ID and then label prefix.
 */
export function searchSchoolOptions(options: SchoolOption[], query: unknown): SchoolOption[] {
	if (typeof query !== 'string' || query.length > MAX_SEARCH_LENGTH) {
		return [];
	}
	const normalizedQuery = normalizeSearchText(query);
	if (normalizedQuery.length < MIN_SEARCH_LENGTH) {
		return [];
	}

	const terms = normalizedQuery.split(/\s+/);
	return options
		.map((option, index) => {
			const label = normalizeSearchText(option.label);
			if (!terms.every(term => label.includes(term))) {
				return undefined;
			}
			const score = option.value === normalizedQuery ? 2 : label.startsWith(normalizedQuery) ? 1 : 0;
			return { option, index, score };
		})
		.filter((item): item is { option: SchoolOption; index: number; score: number } => item !== undefined)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.slice(0, MAX_SEARCH_RESULTS)
		.map(item => item.option);
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
	const contentLength = response.headers.get('content-length');
	if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw new SchoolDirectoryError();
	}
	if (!response.body) {
		return new Uint8Array();
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new SchoolDirectoryError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/**
 * Fetch the school directory from the fixed first-party public endpoint.
 *
 * @param fetchImpl Fetch implementation, injectable for tests.
 * @returns Searchable school options.
 */
export async function fetchSchoolOptions(fetchImpl: typeof fetch = fetch): Promise<SchoolOption[]> {
	try {
		const response = await fetchImpl(SCHOOL_DIRECTORY_URL, {
			method: 'GET',
			headers: { accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new SchoolDirectoryError();
		}
		const payload: unknown = JSON.parse(Buffer.from(await readBoundedBody(response)).toString('utf8'));
		return parseSchoolDirectory(payload);
	} catch (error) {
		if (error instanceof SchoolDirectoryError) {
			throw error;
		}
		throw new SchoolDirectoryError();
	}
}
