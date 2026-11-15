import {
	constants,
	createCipheriv,
	createDecipheriv,
	createHash,
	createPublicKey,
	publicEncrypt,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from 'node:crypto';

const LOGIN_URL = new URL('https://login.schulportal.hessen.de/');
const CONNECT_URL = new URL('https://connect.schulportal.hessen.de/');
const START_URL = new URL('https://start.schulportal.hessen.de/');
const ALLOWED_HOSTS = new Set([LOGIN_URL.hostname, CONNECT_URL.hostname, START_URL.hostname]);
const ADAPTER_USER_AGENT = 'ioBroker.schulportal-hessen';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_SESSION_MAX_AGE_MS = 45 * 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_PREFIX_BYTES = 512;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const SESSION_KEY_BYTES = 46;
const CHALLENGE_BYTES = 48;
// Parent-domain cookies are sent only to the exact hosts accepted by parseAllowedUrl.
const COOKIE_PARENT_DOMAINS = new Set(['hessen.de', 'schulportal.hessen.de']);
const MAX_COOKIE_COUNT = 100;
const MAX_COOKIE_VALUE_BYTES = 4096;
const MAX_COOKIE_HEADER_BYTES = 16 * 1024;
const MAX_USERNAME_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 4096;
const ALLOWED_GET_PATHS = new Set([
	'/stundenplan.php',
	'/kalender.php',
	'/vertretungsplan.php',
	'/meinunterricht.php',
	'/lerngruppen.php',
	'/dateispeicher.php',
	'/benutzerverwaltung.php',
]);
const ALLOWED_GET_QUERY_KEYS: Record<string, ReadonlySet<string>> = {
	'/stundenplan.php': new Set(['a', 'e', 'k', 'p']),
	'/kalender.php': new Set(['a', 'export', 'year']),
	'/vertretungsplan.php': new Set(['tag']),
	'/meinunterricht.php': new Set(['a', 'id', 'cacheBreaker', 'jump']),
	'/lerngruppen.php': new Set(),
	'/dateispeicher.php': new Set(['a', 'folder', 'q']),
	'/benutzerverwaltung.php': new Set(['a']),
};

export type PortalResponseClassification =
	| 'success'
	| 'session-expired'
	| 'forbidden'
	| 'not-found'
	| 'rate-limited'
	| 'redirect'
	| 'redirect-limit'
	| 'blocked-redirect'
	| 'client-error'
	| 'server-error'
	| 'unknown'
	| 'response-too-large';

/** A bounded HTTP response without redirect targets or cookie headers. */
export interface PortalResponse {
	/** Final HTTP status code. */
	status: number;
	/** Generic status classification; response bodies are left for verified parsers. */
	classification: PortalResponseClassification;
	/** Response media type, if supplied. */
	contentType: string | null;
	/** Response bytes, empty for HTTP errors or oversized responses. */
	body: Uint8Array;
	/** Actual response bytes read before decoding, when the body was within the configured limit. */
	bodyByteLength?: number;
	/** Safe size-only details for a response rejected by the configured body limit. */
	responseSizeDiagnostic?: PortalResponseSizeDiagnostic;
	/** Fixed internal reason code for an incomplete multi-request aggregation. */
	diagnosticCode?: string;
}

export type PortalResponsePrefixClassification =
	'json-object-with-rows' | 'json-object' | 'json-array' | 'html' | 'plain-text' | 'unknown' | 'not-inspected';

/** Bounded metadata for a response that exceeded its configured byte limit. */
export interface PortalResponseSizeDiagnostic {
	/** Configured maximum number of response-body bytes. */
	limitBytes: number;
	/** Declared response length, only when it is a safe non-negative integer. */
	declaredContentLength?: number;
	/** Whether the streaming reader observed more than the configured limit. */
	streamingExceededLimit: boolean;
	/** Fixed body-shape classification derived from a small streamed prefix. */
	prefixClassification: PortalResponsePrefixClassification;
}

/** Credentials and bounded transport controls for one school account. */
export interface PortalSessionOptions {
	/** Numeric Schulportal school identifier, preserved as entered. */
	schoolId: string;
	/** Account username; kept private to this session instance. */
	username: string;
	/** Account password; kept private to this session instance. */
	password: string;
	/** Injectable Fetch implementation, intended for synthetic tests. */
	fetchImpl?: typeof fetch;
	/** Injectable clock for deterministic session-expiry tests. */
	now?: () => number;
	/** Per-request timeout, from 1 ms through 60 seconds. */
	requestTimeoutMs?: number;
	/** Authenticated-session maximum age, from 1 ms through 24 hours. */
	sessionMaxAgeMs?: number;
	/** Maximum read-response body size, from 1 byte through 16 MiB. */
	maxResponseBytes?: number;
}

/** Validated input for the portal's read-only calendar query. */
export interface CalendarEventsReadRequest {
	/** Select the read-only calendar API. */
	type: 'calendar-events';
	/** First inclusive calendar date in ISO format. */
	start: string;
	/** Last inclusive calendar date in ISO format. */
	end: string;
	/** Optional calendar search term. */
	search?: string;
}

/** Validated input for the portal's read-only substitution query. */
export interface SubstitutionDayReadRequest {
	/** Select the read-only substitution API. */
	type: 'substitution-day';
	/** Normalized date in DD.MM.YYYY format. */
	date: string;
	/** Original, validated portal data-tag value. */
	portalTag: string;
}

/** Metadata-only conversation overview; never opens or marks a message as read. */
export interface MessageHeadersReadRequest {
	/** Select the conversation headers API. */
	type: 'message-headers';
}

/** Read one validated message conversation, which may mark it read on the portal. */
export interface MessageDetailReadRequest {
	/** Select the conversation detail API. */
	type: 'message-detail';
	/** SHA-256 hash of a visible header ID from the current session's header response. */
	messageIdHash: string;
}

export type PortalReadFormRequest =
	CalendarEventsReadRequest | SubstitutionDayReadRequest | MessageHeadersReadRequest | MessageDetailReadRequest;

export type PortalSessionErrorCode =
	| 'invalid-config'
	| 'invalid-target'
	| 'timeout'
	| 'network-error'
	| 'authentication-failed'
	| 'handshake-failed'
	| 'decode-failed'
	| 'closed';

export type PortalSessionDiagnosticCode =
	| 'login-unexpected-status'
	| 'connect-auth-rejected'
	| 'connect-session-missing-no-cookie'
	| 'connect-session-missing-cookie-sent'
	| 'connect-invalid-response'
	| 'connect-redirect-invalid'
	| 'connect-host-rejected'
	| 'start-auth-rejected'
	| 'start-login-redirect'
	| 'start-redirect-incomplete'
	| 'start-redirect-invalid'
	| 'start-host-rejected'
	| 'start-unexpected-status'
	| 'rsa-public-key-invalid'
	| 'rsa-public-key-response-invalid'
	| 'rsa-handshake-invalid'
	| 'rsa-handshake-response-invalid'
	| 'message-headers-wrapper-invalid'
	| 'message-headers-rows-missing'
	| 'message-headers-rows-invalid'
	| 'message-headers-decryption-failed'
	| 'message-headers-decrypted-json-invalid'
	| 'message-headers-decrypted-shape-invalid'
	| 'message-headers-row-id-invalid'
	| 'message-detail-wrapper-invalid'
	| 'message-detail-message-missing'
	| 'message-detail-decryption-failed'
	| 'message-detail-json-invalid'
	| 'message-detail-shape-invalid';

const ERROR_MESSAGES: Record<PortalSessionErrorCode, string> = {
	'invalid-config': 'Portal session configuration is invalid.',
	'invalid-target': 'Portal request target is not allowed.',
	timeout: 'Portal request timed out.',
	'network-error': 'Portal request failed.',
	'authentication-failed': 'Portal authentication failed.',
	'handshake-failed': 'Portal session handshake failed.',
	'decode-failed': 'Portal response decoding failed.',
	closed: 'Portal session is closed.',
};

/** Safe error with a stable code and a message that excludes transport details. */
export class PortalSessionError extends Error {
	/**
	 * Create an error that does not include credentials, URLs, or raw network messages.
	 *
	 * @param code Stable public error code.
	 * @param diagnosticCode Safe protocol-phase diagnostic, when available.
	 * @param httpStatus Numeric HTTP response status, when available.
	 */
	constructor(
		public readonly code: PortalSessionErrorCode,
		public readonly diagnosticCode?: PortalSessionDiagnosticCode,
		public readonly httpStatus?: number,
	) {
		super(ERROR_MESSAGES[code]);
		this.name = 'PortalSessionError';
	}
}

/**
 * Classify an HTTP status without relying on portal-specific response text.
 *
 * @param status HTTP status code to classify.
 */
export function classifyPortalStatus(status: number): PortalResponseClassification {
	if (status >= 200 && status < 300) {
		return 'success';
	}
	if (status === 401) {
		return 'session-expired';
	}
	if (status === 403) {
		return 'forbidden';
	}
	if (status === 404) {
		return 'not-found';
	}
	if (status === 429) {
		return 'rate-limited';
	}
	if (status >= 300 && status < 400) {
		return 'redirect';
	}
	if (status >= 400 && status < 500) {
		return 'client-error';
	}
	if (status >= 500 && status < 600) {
		return 'server-error';
	}
	return 'unknown';
}

class ResponseBodyTooLargeError extends Error {
	readonly diagnostic: PortalResponseSizeDiagnostic;

	constructor(
		limitBytes: number,
		declaredContentLength: number | undefined,
		streamingExceededLimit: boolean,
		prefixClassification: PortalResponsePrefixClassification = 'not-inspected',
	) {
		super();
		this.name = 'ResponseBodyTooLargeError';
		this.diagnostic = {
			limitBytes,
			...(declaredContentLength === undefined ? {} : { declaredContentLength }),
			streamingExceededLimit,
			prefixClassification,
		};
	}
}

interface CookieEntry {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	path: string;
	secure: boolean;
	expiresAt: number | null;
}

class PortalCookieJar {
	private readonly cookies = new Map<string, CookieEntry>();

	constructor(private readonly now: () => number) {}

	clear(): void {
		this.cookies.clear();
	}

	store(url: URL, headers: Headers): void {
		for (const header of getSetCookieValues(headers)) {
			const parts = header.split(';');
			const pair = parts.shift()?.trim() ?? '';
			const equalsIndex = pair.indexOf('=');
			if (equalsIndex < 1) {
				continue;
			}

			const name = pair.slice(0, equalsIndex).trim();
			const value = pair.slice(equalsIndex + 1).trim();
			if (
				!isCookieName(name) ||
				!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value) ||
				Buffer.byteLength(value) > MAX_COOKIE_VALUE_BYTES
			) {
				continue;
			}

			let domain = url.hostname.toLowerCase();
			let hostOnly = true;
			let path = defaultCookiePath(url.pathname);
			let secure = false;
			let expiresAt: number | null = null;
			let maxAge: number | null = null;

			for (const rawAttribute of parts) {
				const separator = rawAttribute.indexOf('=');
				const attribute = (separator < 0 ? rawAttribute : rawAttribute.slice(0, separator))
					.trim()
					.toLowerCase();
				const attributeValue = separator < 0 ? '' : rawAttribute.slice(separator + 1).trim();
				switch (attribute) {
					case 'domain': {
						const candidate = attributeValue.replace(/^\./, '').toLowerCase();
						if (!isAllowedCookieDomain(candidate, url.hostname)) {
							domain = '';
							break;
						}
						domain = candidate;
						hostOnly = false;
						break;
					}
					case 'path':
						if (attributeValue.startsWith('/')) {
							path = attributeValue;
						}
						break;
					case 'secure':
						secure = true;
						break;
					case 'max-age':
						if (/^-?\d+$/.test(attributeValue)) {
							const parsed = Number(attributeValue);
							if (Number.isFinite(parsed)) {
								maxAge = parsed;
							}
						}
						break;
					case 'expires': {
						const parsed = Date.parse(attributeValue);
						if (Number.isFinite(parsed)) {
							expiresAt = parsed;
						}
						break;
					}
				}
			}

			if (!domain || (secure && url.protocol !== 'https:')) {
				continue;
			}
			if (maxAge !== null) {
				expiresAt = this.now() + maxAge * 1000;
			}

			const key = cookieKey(domain, path, name);
			if (expiresAt !== null && expiresAt <= this.now()) {
				this.cookies.delete(key);
				continue;
			}
			this.cookies.delete(key);
			this.cookies.set(key, { name, value, domain, hostOnly, path, secure, expiresAt });
		}

		this.prune();
	}

	header(url: URL): string | undefined {
		this.prune();
		const matches = [...this.cookies.values()]
			.filter(
				cookie =>
					((cookie.hostOnly ? url.hostname === cookie.domain : domainMatches(url.hostname, cookie.domain)) ||
						(cookie.name === 'sid' &&
							cookie.hostOnly &&
							ALLOWED_HOSTS.has(cookie.domain) &&
							ALLOWED_HOSTS.has(url.hostname))) &&
					url.pathname.startsWith(cookie.path) &&
					(cookie.path.endsWith('/') ||
						url.pathname.length === cookie.path.length ||
						url.pathname[cookie.path.length] === '/') &&
					(!cookie.secure || url.protocol === 'https:'),
			)
			.sort((left, right) => right.path.length - left.path.length);
		return matches.length ? matches.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') : undefined;
	}

	private prune(): void {
		const now = this.now();
		for (const [key, cookie] of this.cookies) {
			if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
				this.cookies.delete(key);
			}
		}
		let headerBytes = [...this.cookies.values()].reduce(
			(total, cookie) => total + Buffer.byteLength(`${cookie.name}=${cookie.value}`) + 2,
			0,
		);
		while (this.cookies.size > MAX_COOKIE_COUNT || headerBytes > MAX_COOKIE_HEADER_BYTES) {
			const oldestKey = this.cookies.keys().next().value;
			if (oldestKey === undefined) {
				break;
			}
			const oldest = this.cookies.get(oldestKey);
			if (oldest) {
				headerBytes -= Buffer.byteLength(`${oldest.name}=${oldest.value}`) + 2;
			}
			this.cookies.delete(oldestKey);
		}
	}
}

function getSetCookieValues(headers: Headers): string[] {
	const headersWithSetCookie = headers as Headers & { getSetCookie?: () => string[] };
	if (typeof headersWithSetCookie.getSetCookie === 'function') {
		return headersWithSetCookie.getSetCookie();
	}
	const combined = headers.get('set-cookie');
	return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/) : [];
}

function isCookieName(name: string): boolean {
	return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}

function isAllowedCookieDomain(domain: string, sourceHost: string): boolean {
	return (ALLOWED_HOSTS.has(domain) || COOKIE_PARENT_DOMAINS.has(domain)) && domainMatches(sourceHost, domain);
}

function domainMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

function defaultCookiePath(pathname: string): string {
	if (!pathname.startsWith('/') || pathname === '/') {
		return '/';
	}
	const lastSlash = pathname.lastIndexOf('/');
	return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function cookieKey(domain: string, path: string, name: string): string {
	return `${domain}\u0000${path}\u0000${name}`;
}

function validateOption(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new PortalSessionError('invalid-config');
	}
	return value;
}

function parseAllowedUrl(value: string | URL, base?: URL): URL {
	let url: URL;
	try {
		url = value instanceof URL ? new URL(value.toString()) : new URL(value, base);
	} catch {
		throw new PortalSessionError('invalid-target');
	}
	if (
		url.protocol !== 'https:' ||
		!ALLOWED_HOSTS.has(url.hostname.toLowerCase()) ||
		url.port !== '' ||
		url.username !== '' ||
		url.password !== ''
	) {
		throw new PortalSessionError('invalid-target');
	}
	return url;
}

function getReadTarget(path: string): URL {
	if (
		typeof path !== 'string' ||
		path.length === 0 ||
		path.length > 8192 ||
		!path.startsWith('/') ||
		path.startsWith('//') ||
		/[\\\r\n\0#]/.test(path)
	) {
		throw new PortalSessionError('invalid-target');
	}
	const url = parseAllowedUrl(path, START_URL);
	if (url.hostname !== START_URL.hostname || !isSafeReadTarget(url)) {
		throw new PortalSessionError('invalid-target');
	}
	return url;
}

function isSafeReadTarget(url: URL): boolean {
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname).toLowerCase();
	} catch {
		return false;
	}
	const allowedKeys = ALLOWED_GET_QUERY_KEYS[pathname];
	if (!ALLOWED_GET_PATHS.has(pathname) || !allowedKeys) {
		return false;
	}

	const seenKeys = new Set<string>();
	for (const key of url.searchParams.keys()) {
		if (!allowedKeys.has(key) || seenKeys.has(key)) {
			return false;
		}
		seenKeys.add(key);
	}

	const value = (key: string): string | null => url.searchParams.get(key);
	const action = value('a')?.toLowerCase() ?? null;
	switch (pathname) {
		case '/stundenplan.php': {
			const classId = value('k');
			const studentId = value('p');
			const hasDetailQuery = action !== null || value('e') !== null || classId !== null || studentId !== null;
			if (!hasDetailQuery) {
				return true;
			}
			return (
				action === 'detail_klasse' &&
				value('e') === '1' &&
				classId !== null &&
				/^[a-z0-9_-]{1,64}$/i.test(classId) &&
				studentId !== null &&
				/^\d{1,20}$/.test(studentId)
			);
		}
		case '/kalender.php': {
			if (action !== null && action !== 'export') {
				return false;
			}
			const exportType = value('export')?.toLowerCase() ?? null;
			const year = value('year');
			const hasExportArguments = exportType !== null && year !== null;
			return (
				(action === 'export' ? hasExportArguments : exportType === null && year === null) &&
				(exportType === null || exportType === 'csv' || exportType === 'ical') &&
				(year === null || /^(?:19|20|21)\d{2}$/.test(year))
			);
		}
		case '/vertretungsplan.php':
			return value('tag') === null || isGermanDate(value('tag') ?? '');
		case '/meinunterricht.php': {
			const courseId = value('id');
			const cacheBreaker = value('cacheBreaker');
			const jump = value('jump');
			return (
				(action === null || action === 'view') &&
				(action !== 'view' || (courseId !== null && /^\d{1,20}$/.test(courseId))) &&
				(cacheBreaker === null || /^\d{1,16}$/.test(cacheBreaker)) &&
				(jump === null || jump === 'no') &&
				(courseId === null || action === 'view')
			);
		}
		case '/lerngruppen.php':
			return url.search.length === 0;
		case '/dateispeicher.php': {
			const folder = value('folder');
			const query = value('q');
			return (
				(action === null || action === 'view' || action === 'searchfiles') &&
				(folder === null || /^\d{1,20}$/.test(folder)) &&
				(query === null || query.length <= 256) &&
				(action !== 'searchfiles' || query !== null) &&
				(action !== 'view' || query === null)
			);
		}
		case '/benutzerverwaltung.php':
			return action === 'userdata';
		default:
			return false;
	}
}

function isGermanDate(value: string): boolean {
	const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
	if (!match) {
		return false;
	}
	const [, dayText, monthText, yearText] = match;
	const day = Number(dayText);
	const month = Number(monthText);
	const year = Number(yearText);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isPortalSubstitutionTag(value: string, normalizedDate: string): boolean {
	const match = /^(\d{2})([._])(\d{2})\2(\d{4})$/.exec(value);
	return match !== null && isGermanDate(normalizedDate) && `${match[1]}.${match[3]}.${match[4]}` === normalizedDate;
}

function hasControlCharacters(value: string): boolean {
	return Array.from(value).some(character => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

function isSafeMessageSourceId(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 256 &&
		Buffer.byteLength(value, 'utf8') <= 256 &&
		Buffer.from(value, 'utf8').toString('utf8') === value &&
		value.trim() === value &&
		!hasControlCharacters(value) &&
		!/\s/u.test(value) &&
		!Array.from(value).some(character => {
			const code = character.charCodeAt(0);
			return code >= 127 && code <= 159;
		})
	);
}

function hasUnsafeMessageTextControlCharacters(value: string): boolean {
	return Array.from(value).some(character => {
		const code = character.charCodeAt(0);
		return (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159);
	});
}

function isIsoDate(value: string): boolean {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) {
		return false;
	}
	const [, yearText, monthText, dayText] = match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

interface MessageDetailDecodeContext {
	idHash: string;
	sourceId: string;
}

interface PreparedReadFormRequest {
	url: URL;
	body: string;
	headers?: Record<string, string>;
	decodeMessageHeaders?: boolean;
	messageDetail?: MessageDetailDecodeContext;
}

function createReadFormRequest(
	request: PortalReadFormRequest,
	sessionKey: Buffer | null,
	messageSourceIds: ReadonlyMap<string, string>,
): PreparedReadFormRequest {
	if (request.type === 'calendar-events') {
		if (
			!isIsoDate(request.start) ||
			!isIsoDate(request.end) ||
			request.start > request.end ||
			(Date.parse(`${request.end}T00:00:00Z`) - Date.parse(`${request.start}T00:00:00Z`)) / 86_400_000 > 500 ||
			(request.search !== undefined &&
				(typeof request.search !== 'string' ||
					request.search.length > 128 ||
					hasControlCharacters(request.search)))
		) {
			throw new PortalSessionError('invalid-target');
		}
		const url = new URL('/kalender.php', START_URL);
		for (const [key, value] of Object.entries({
			f: 'getEvents',
			s: request.search ?? '',
			start: request.start,
			end: request.end,
		})) {
			url.searchParams.set(key, value);
		}
		const body = new URLSearchParams({
			f: 'getEvents',
			start: request.start,
			end: request.end,
			s: request.search ?? '',
		}).toString();
		return {
			url,
			body,
			headers: {
				accept: '*/*',
				'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
				'sec-fetch-dest': 'empty',
				'sec-fetch-mode': 'cors',
				'sec-fetch-site': 'same-origin',
			},
		};
	}
	if (
		request.type === 'substitution-day' &&
		isGermanDate(request.date) &&
		isPortalSubstitutionTag(request.portalTag, request.date)
	) {
		const url = new URL('/vertretungsplan.php', START_URL);
		url.searchParams.set('a', 'my');
		const body = new URLSearchParams({ tag: request.portalTag, ganzerPlan: 'true' }).toString();
		return { url, body, headers: { 'X-Requested-With': 'XMLHttpRequest' } };
	}
	if (request.type === 'message-headers') {
		const url = new URL('/nachrichten.php', START_URL);
		const body = new URLSearchParams({ a: 'headers', getType: 'All', last: '0' }).toString();
		return {
			url,
			body,
			headers: {
				accept: '*/*',
				'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
				'sec-fetch-dest': 'empty',
				'sec-fetch-mode': 'cors',
				'sec-fetch-site': 'same-origin',
				'X-Requested-With': 'XMLHttpRequest',
			},
			decodeMessageHeaders: true,
		};
	}
	if (request.type === 'message-detail') {
		if (!/^[a-f0-9]{64}$/u.test(request.messageIdHash)) {
			throw new PortalSessionError('invalid-target');
		}
		const sourceId = messageSourceIds.get(request.messageIdHash);
		if (!sessionKey || !sourceId || !isSafeMessageSourceId(sourceId)) {
			throw new PortalSessionError('invalid-target');
		}
		const url = new URL('/nachrichten.php', START_URL);
		url.searchParams.set('a', 'read');
		url.searchParams.set('msg', sourceId);
		const encryptedId = encryptOpenSslPayload(sourceId, sessionKey);
		const body = new URLSearchParams({ a: 'read', uniqid: encryptedId }).toString();
		return {
			url,
			body,
			headers: {
				accept: '*/*',
				'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
				'sec-fetch-dest': 'empty',
				'sec-fetch-mode': 'cors',
				'sec-fetch-site': 'same-origin',
				'X-Requested-With': 'XMLHttpRequest',
			},
			messageDetail: { idHash: request.messageIdHash, sourceId },
		};
	}
	throw new PortalSessionError('invalid-target');
}

function isRedirect(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isLoginHostRedirect(location: string, from: URL): boolean {
	try {
		const target = parseAllowedUrl(location, from);
		return target.hostname === LOGIN_URL.hostname || target.hostname === CONNECT_URL.hostname;
	} catch {
		return false;
	}
}

function responseResult(
	status: number,
	classification: PortalResponseClassification,
	contentType: string | null = null,
	body: Uint8Array = new Uint8Array(),
	diagnostics: Pick<PortalResponse, 'bodyByteLength' | 'responseSizeDiagnostic'> = {},
): PortalResponse {
	return { status, classification, contentType, body, ...diagnostics };
}

function getSafeContentLength(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function findNextJsonObjectDelimiter(value: string, start: number): number {
	let nestedDepth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < value.length; index++) {
		const character = value[index];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === '"') {
				inString = false;
			}
			continue;
		}
		if (character === '"') {
			inString = true;
		} else if (character === '{' || character === '[') {
			nestedDepth++;
		} else if (character === '}' || character === ']') {
			if (nestedDepth === 0) {
				return index;
			}
			nestedDepth--;
		} else if (character === ',' && nestedDepth === 0) {
			return index + 1;
		}
	}
	return value.length;
}

function hasTopLevelRowsKey(prefix: string): boolean {
	let index = 1;
	while (index < prefix.length) {
		while (/\s|,/u.test(prefix[index] ?? '')) {
			index++;
		}
		if (prefix[index] !== '"') {
			return false;
		}
		const keyStart = ++index;
		let escaped = false;
		for (; index < prefix.length; index++) {
			const character = prefix[index];
			if (escaped) {
				escaped = false;
			} else if (character === '\\') {
				escaped = true;
			} else if (character === '"') {
				break;
			}
		}
		if (index >= prefix.length) {
			return false;
		}
		const key = prefix.slice(keyStart, index);
		index++;
		while (/\s/u.test(prefix[index] ?? '')) {
			index++;
		}
		if (prefix[index] !== ':') {
			return false;
		}
		if (key === 'rows') {
			return true;
		}
		index = findNextJsonObjectDelimiter(prefix, index + 1);
	}
	return false;
}

function classifyResponsePrefix(prefix: Uint8Array): PortalResponsePrefixClassification {
	const text = Buffer.from(prefix)
		.toString('utf8')
		.replace(/^\uFEFF/u, '')
		.trimStart();
	if (!text) {
		return 'unknown';
	}
	if (text.startsWith('{')) {
		return hasTopLevelRowsKey(text) ? 'json-object-with-rows' : 'json-object';
	}
	if (text.startsWith('[')) {
		return 'json-array';
	}
	if (/^(?:<!doctype\s+html\b|<(?:html|head|body|table|form|div|meta|script|link|main|section)\b)/iu.test(text)) {
		return 'html';
	}
	const sample = Array.from(text.slice(0, 128));
	return sample.length > 0 &&
		sample.every(character => {
			const codePoint = character.codePointAt(0) ?? 0;
			return (
				codePoint === 9 ||
				codePoint === 10 ||
				codePoint === 13 ||
				(codePoint >= 0x20 && (codePoint < 0x80 || codePoint >= 0xa0) && codePoint !== 0xfffd)
			);
		})
		? 'plain-text'
		: 'unknown';
}

async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// The response may already have been aborted by the request timeout.
	}
}

function deriveChallengeKeyAndIv(secret: Uint8Array, salt: Uint8Array): { key: Buffer; iv: Buffer } {
	// The portal challenge uses OpenSSL's Salted__ MD5 derivation with AES-256-CBC.
	let material = Buffer.alloc(0);
	let previous = Buffer.alloc(0);
	while (material.length < CHALLENGE_BYTES) {
		previous = createHash('md5').update(previous).update(secret).update(salt).digest();
		material = Buffer.concat([material, previous]);
	}
	return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

function encryptOpenSslPayload(plaintext: string, sessionKey: Buffer): string {
	const salt = randomBytes(8);
	const { key, iv } = deriveChallengeKeyAndIv(sessionKey, salt);
	const cipher = createCipheriv('aes-256-cbc', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return Buffer.concat([Buffer.from('Salted__'), salt, ciphertext]).toString('base64');
}

function verifyChallenge(challengeValue: unknown, sessionKey: Buffer): boolean {
	if (
		typeof challengeValue !== 'string' ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(challengeValue)
	) {
		return false;
	}
	const payload = Buffer.from(challengeValue, 'base64');
	if (payload.length < 16 + 16 || payload.subarray(0, 8).toString('ascii') !== 'Salted__') {
		return false;
	}
	try {
		const { key, iv } = deriveChallengeKeyAndIv(sessionKey, payload.subarray(8, 16));
		const decipher = createDecipheriv('aes-256-cbc', key, iv);
		const plaintext = Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]);
		return plaintext.length === SESSION_KEY_BYTES && timingSafeEqual(plaintext, sessionKey);
	} catch {
		return false;
	}
}

function isLoginPage(body: Uint8Array, contentType: string | null): boolean {
	const html = Buffer.from(body).toString('utf8').slice(0, MAX_AUTH_RESPONSE_BYTES).toLowerCase();
	if (!contentType?.toLowerCase().includes('html') && !/^\s*(?:<!doctype\s+html|<html\b)/.test(html)) {
		return false;
	}
	const hasLoginForm =
		/<input\b[^>]*\bname\s*=\s*["']?user2["']?[^>]*>/.test(html) &&
		/<input\b[^>]*\bname\s*=\s*["']?password["']?[^>]*>/.test(html);
	const visibleText = html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
	return (
		hasLoginForm ||
		/\blogin\s+nötig\b|\bmuss(?:\s+man)?\s+eingeloggt\s+sein\b|\blogin\s+required\b|\bmust\s+be\s+logged\s+in\b/u.test(
			visibleText,
		)
	);
}

function decryptOpenSslPayload(encoded: string, sessionKey: Buffer | null): string {
	if (!sessionKey || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
		throw new PortalSessionError('decode-failed');
	}
	const payload = Buffer.from(encoded, 'base64');
	if (payload.length < 32 || payload.subarray(0, 8).toString('ascii') !== 'Salted__') {
		throw new PortalSessionError('decode-failed');
	}
	try {
		const { key, iv } = deriveChallengeKeyAndIv(sessionKey, payload.subarray(8, 16));
		const decipher = createDecipheriv('aes-256-cbc', key, iv);
		return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString('utf8');
	} catch {
		throw new PortalSessionError('decode-failed');
	}
}

function decodeMessageHeaderRows(
	body: Uint8Array,
	sessionKey: Buffer | null,
): { body: Uint8Array; sourceIds: ReadonlyMap<string, string> } {
	let wrapper: unknown;
	try {
		wrapper = JSON.parse(Buffer.from(body).toString('utf8'));
	} catch {
		throw new PortalSessionError('decode-failed', 'message-headers-wrapper-invalid');
	}
	if (!isRecord(wrapper)) {
		throw new PortalSessionError('decode-failed', 'message-headers-wrapper-invalid');
	}
	if (!Object.hasOwn(wrapper, 'rows')) {
		throw new PortalSessionError('decode-failed', 'message-headers-rows-missing');
	}
	if (typeof wrapper.rows !== 'string') {
		throw new PortalSessionError('decode-failed', 'message-headers-rows-invalid');
	}

	let decryptedRows: string;
	try {
		decryptedRows = decryptOpenSslPayload(wrapper.rows, sessionKey);
	} catch {
		throw new PortalSessionError('decode-failed', 'message-headers-decryption-failed');
	}

	let rows: unknown;
	try {
		rows = JSON.parse(decryptedRows);
	} catch {
		throw new PortalSessionError('decode-failed', 'message-headers-decrypted-json-invalid');
	}
	if (!Array.isArray(rows) || !rows.every(isRecord)) {
		throw new PortalSessionError('decode-failed', 'message-headers-decrypted-shape-invalid');
	}

	const sourceIds = new Map<string, string>();
	const metadata = rows.map(row => {
		const sourceId = row.Uniquid;
		if (
			!(typeof sourceId === 'string' && sourceId.trim() && sourceId.length <= 256) &&
			!(typeof sourceId === 'number' && Number.isSafeInteger(sourceId))
		) {
			throw new PortalSessionError('decode-failed', 'message-headers-row-id-invalid');
		}
		const sourceIdText = String(sourceId);
		const idHash = createHash('sha256').update(sourceIdText).digest('hex');
		const record: Record<string, unknown> = { id: idHash };
		if (row.Papierkorb === 'nein' && messageSourceId(sourceId) !== null) {
			sourceIds.set(idHash, sourceIdText);
		}
		for (const [sourceName, targetName] of [
			['Betreff', 'subject'],
			['kuerzel', 'senderShortName'],
			['SenderName', 'senderName'],
			['Datum', 'date'],
		] as const) {
			const value = row[sourceName];
			if (typeof value === 'string' && value.length <= 8192 && !hasControlCharacters(value)) {
				record[targetName] = value;
			}
		}
		if (row.unread === 0 || row.unread === 1) {
			record.unread = row.unread === 1;
		}
		if (row.Papierkorb === 'ja' || row.Papierkorb === 'nein') {
			record.hidden = row.Papierkorb === 'ja';
		}
		return record;
	});
	return { body: Buffer.from(JSON.stringify(metadata), 'utf8'), sourceIds };
}

function decodeMessageDetail(
	body: Uint8Array,
	sessionKey: Buffer | null,
	context: MessageDetailDecodeContext,
): Uint8Array {
	let wrapper: unknown;
	try {
		wrapper = JSON.parse(Buffer.from(body).toString('utf8'));
	} catch {
		throw new PortalSessionError('decode-failed', 'message-detail-wrapper-invalid');
	}
	if (!isRecord(wrapper)) {
		throw new PortalSessionError('decode-failed', 'message-detail-wrapper-invalid');
	}
	if (!Object.hasOwn(wrapper, 'message')) {
		throw new PortalSessionError('decode-failed', 'message-detail-message-missing');
	}
	if (typeof wrapper.message !== 'string' || !Number.isSafeInteger(wrapper.time) || (wrapper.time as number) < 0) {
		throw new PortalSessionError('decode-failed', 'message-detail-wrapper-invalid');
	}

	let decoded: string;
	try {
		decoded = decryptOpenSslPayload(wrapper.message, sessionKey);
	} catch {
		throw new PortalSessionError('decode-failed', 'message-detail-decryption-failed');
	}

	let conversation: unknown;
	try {
		conversation = JSON.parse(decoded);
	} catch {
		throw new PortalSessionError('decode-failed', 'message-detail-json-invalid');
	}
	if (!isRecord(conversation)) {
		throw new PortalSessionError('decode-failed', 'message-detail-shape-invalid');
	}

	const parent = parseMessageDetailItem(conversation);
	const sourceId = messageSourceId(conversation.Uniquid);
	const statistics = conversation.statistik;
	if (
		!parent ||
		!sourceId ||
		createHash('sha256').update(sourceId).digest('hex') !== context.idHash ||
		sourceId !== context.sourceId ||
		!Array.isArray(conversation.reply) ||
		conversation.reply.length > 100 ||
		!conversation.reply.every(isRecord) ||
		!isRecord(statistics) ||
		!isNonNegativeSafeInteger(statistics.teilnehmer) ||
		!isNonNegativeSafeInteger(statistics.betreuer) ||
		!isNonNegativeSafeInteger(statistics.eltern) ||
		!isJaNein(conversation.groupOnly) ||
		!isJaNein(conversation.privateAnswerOnly) ||
		!isJaNein(conversation.noAnswerAllowed)
	) {
		throw new PortalSessionError('decode-failed', 'message-detail-shape-invalid');
	}

	const replies = conversation.reply.map(reply => {
		const parsed = parseMessageDetailItem(reply);
		if (!parsed || !messageSourceId(reply.Uniquid)) {
			throw new PortalSessionError('decode-failed', 'message-detail-shape-invalid');
		}
		return parsed;
	});
	return Buffer.from(
		JSON.stringify({
			id: context.idHash,
			...parent,
			replies,
			time: wrapper.time,
			groupChat: conversation.groupOnly === 'ja',
			onlyPrivateAnswers: conversation.privateAnswerOnly === 'ja',
			noReply: conversation.noAnswerAllowed === 'ja',
			participantCounts: {
				students: statistics.teilnehmer,
				teachers: statistics.betreuer,
				parents: statistics.eltern,
			},
		}),
		'utf8',
	);
}

function parseMessageDetailItem(value: Record<string, unknown>): Record<string, unknown> | null {
	const id = messageSourceId(value.Uniquid);
	if (
		!id ||
		typeof value.Datum !== 'string' ||
		value.Datum.length > 8192 ||
		hasControlCharacters(value.Datum) ||
		typeof value.username !== 'string' ||
		value.username.length > 8192 ||
		hasControlCharacters(value.username) ||
		typeof value.own !== 'boolean' ||
		typeof value.Inhalt !== 'string' ||
		value.Inhalt.length > 4 * 1024 * 1024 ||
		hasUnsafeMessageTextControlCharacters(value.Inhalt)
	) {
		return null;
	}
	return {
		id: createHash('sha256').update(id).digest('hex'),
		date: value.Datum,
		username: value.username,
		own: value.own,
		content: value.Inhalt,
	};
}

function messageSourceId(value: unknown): string | null {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		return String(value);
	}
	return typeof value === 'string' && isSafeMessageSourceId(value) ? value : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isJaNein(value: unknown): value is 'ja' | 'nein' {
	return value === 'ja' || value === 'nein';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeEncryptedFragments(body: Uint8Array, sessionKey: Buffer | null): Uint8Array {
	const source = Buffer.from(body).toString('utf8');
	if (!/<encoded(?:\s[^>]*)?>[\s\S]*?<\/encoded\s*>/i.test(source)) {
		return body;
	}
	const decoded = source.replace(/<encoded(?:\s[^>]*)?>([\s\S]*?)<\/encoded\s*>/gi, (_tag, value: string) =>
		decryptOpenSslPayload(value.replace(/\s+/g, ''), sessionKey),
	);
	return Buffer.from(decoded, 'utf8');
}

/** An isolated authenticated session exposing only verified Schulportal data requests. */
export class PortalSession {
	private readonly cookies: PortalCookieJar;
	private readonly messageSourceIds = new Map<string, string>();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly requestTimeoutMs: number;
	private readonly sessionMaxAgeMs: number;
	private readonly maxResponseBytes: number;
	private sessionKey: Buffer | null = null;
	private authenticatedAt: number | null = null;
	private generation = 0;
	private authenticationInFlight: Promise<void> | null = null;
	private readonly activeControllers = new Set<AbortController>();
	private closed = false;

	/**
	 * Create an isolated client with a private cookie jar and session key.
	 *
	 * @param options Account credentials and optional test/transport controls.
	 */
	constructor(private readonly options: PortalSessionOptions) {
		if (
			typeof options.schoolId !== 'string' ||
			!/^\d{1,20}$/.test(options.schoolId) ||
			typeof options.username !== 'string' ||
			options.username.length === 0 ||
			options.username.length > MAX_USERNAME_LENGTH ||
			typeof options.password !== 'string' ||
			options.password.length === 0 ||
			options.password.length > MAX_PASSWORD_LENGTH
		) {
			throw new PortalSessionError('invalid-config');
		}
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.now = options.now ?? Date.now;
		this.requestTimeoutMs = validateOption(
			options.requestTimeoutMs,
			DEFAULT_REQUEST_TIMEOUT_MS,
			MAX_REQUEST_TIMEOUT_MS,
		);
		this.sessionMaxAgeMs = validateOption(options.sessionMaxAgeMs, DEFAULT_SESSION_MAX_AGE_MS, 24 * 60 * 60_000);
		this.maxResponseBytes = validateOption(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024);
		this.cookies = new PortalCookieJar(this.now);
	}

	/** Authenticate if no current session exists or the session has expired. */
	async authenticate(): Promise<void> {
		await this.authenticateIfNeeded(false);
	}

	/**
	 * Make a bounded GET to a start-host path, refreshing an expired session once.
	 *
	 * @param path Portal-relative path and query for a verified read endpoint.
	 */
	async get(path: string): Promise<PortalResponse> {
		const target = getReadTarget(path);
		return this.withSessionRetry(() => this.getFollowingRedirects(target));
	}

	/**
	 * Make one of the verified form-based data reads; arbitrary POST actions are not exposed.
	 *
	 * @param request Read-only portal form request.
	 */
	async postRead(request: PortalReadFormRequest): Promise<PortalResponse> {
		if (request.type === 'message-headers') {
			this.messageSourceIds.clear();
		}
		const preparedRequest =
			request.type === 'message-detail'
				? undefined
				: createReadFormRequest(request, this.sessionKey, this.messageSourceIds);
		if (request.type === 'message-detail') {
			const sourceId = this.messageSourceIds.get(request.messageIdHash);
			if (!/^[a-f0-9]{64}$/u.test(request.messageIdHash) || !sourceId || !isSafeMessageSourceId(sourceId)) {
				throw new PortalSessionError('invalid-target');
			}
		}
		try {
			return await this.withSessionRetry(() => {
				const formRequest =
					preparedRequest ?? createReadFormRequest(request, this.sessionKey, this.messageSourceIds);
				return this.postReadOnce(
					formRequest.url,
					formRequest.body,
					formRequest.headers,
					formRequest.decodeMessageHeaders,
					formRequest.messageDetail,
				);
			});
		} finally {
			if (request.type === 'message-detail') {
				this.messageSourceIds.delete(request.messageIdHash);
			}
		}
	}

	/** Discard transient source IDs retained only to make validated detail reads. */
	discardMessageSourceIds(): void {
		this.messageSourceIds.clear();
	}

	/** Abort active requests and erase cookies/session key before shutdown. */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.authenticatedAt = null;
		this.sessionKey?.fill(0);
		this.sessionKey = null;
		this.messageSourceIds.clear();
		this.cookies.clear();
		for (const controller of this.activeControllers) {
			controller.abort();
		}
		this.activeControllers.clear();
	}

	private async withSessionRetry(send: () => Promise<PortalResponse>): Promise<PortalResponse> {
		await this.authenticateIfNeeded(false);
		let observedGeneration = this.generation;

		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await send();
			if (result.classification !== 'session-expired' || attempt === 1) {
				return result;
			}
			await this.authenticateIfNeeded(this.generation === observedGeneration);
			observedGeneration = this.generation;
		}
		return responseResult(401, 'session-expired');
	}

	private async postReadOnce(
		url: URL,
		body: string,
		extraHeaders: Record<string, string> = {},
		decodeHeaders = false,
		messageDetail?: MessageDetailDecodeContext,
	): Promise<PortalResponse> {
		return this.withRequest(
			url,
			{
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
				body,
			},
			async response => {
				const contentType = response.headers.get('content-type');
				const location = response.headers.get('location');
				if (
					response.status === 401 ||
					(isRedirect(response.status) && isLoginHostRedirect(location ?? '', url))
				) {
					await cancelBody(response);
					return responseResult(response.status, 'session-expired', contentType);
				}
				if (isRedirect(response.status)) {
					await cancelBody(response);
					if (!location) {
						return responseResult(response.status, 'redirect', contentType);
					}
					try {
						const redirectTarget = parseAllowedUrl(location, url);
						return responseResult(
							response.status,
							redirectTarget.hostname === START_URL.hostname && isSafeReadTarget(redirectTarget)
								? 'redirect'
								: 'blocked-redirect',
							contentType,
						);
					} catch {
						return responseResult(response.status, 'blocked-redirect', contentType);
					}
				}
				if (response.status < 200 || response.status >= 300) {
					await cancelBody(response);
					return responseResult(response.status, classifyPortalStatus(response.status), contentType);
				}
				try {
					const rawBody = await this.readResponseBody(response, this.maxResponseBytes);
					const decodedBody = decodeEncryptedFragments(rawBody, this.sessionKey);
					if (isLoginPage(decodedBody, contentType)) {
						return responseResult(401, 'session-expired', contentType);
					}
					let resultBody = decodedBody;
					if (decodeHeaders) {
						const decodedHeaders = decodeMessageHeaderRows(decodedBody, this.sessionKey);
						this.messageSourceIds.clear();
						for (const [hash, sourceId] of decodedHeaders.sourceIds) {
							this.messageSourceIds.set(hash, sourceId);
						}
						resultBody = decodedHeaders.body;
					} else if (messageDetail) {
						resultBody = decodeMessageDetail(decodedBody, this.sessionKey, messageDetail);
					}
					return responseResult(response.status, 'success', contentType, resultBody, {
						bodyByteLength: rawBody.byteLength,
					});
				} catch (error) {
					if (error instanceof ResponseBodyTooLargeError) {
						return responseResult(response.status, 'response-too-large', contentType, undefined, {
							responseSizeDiagnostic: error.diagnostic,
						});
					}
					throw error;
				}
			},
		);
	}

	private authenticateIfNeeded(force: boolean): Promise<void> {
		if (this.closed) {
			return Promise.reject(new PortalSessionError('closed'));
		}
		if (this.authenticationInFlight) {
			return this.authenticationInFlight;
		}
		if (!force && this.isSessionFresh()) {
			return Promise.resolve();
		}

		const authentication = this.performAuthentication();
		this.authenticationInFlight = authentication;
		return authentication.finally(() => {
			if (this.authenticationInFlight === authentication) {
				this.authenticationInFlight = null;
			}
		});
	}

	private isSessionFresh(): boolean {
		return this.authenticatedAt !== null && this.now() - this.authenticatedAt < this.sessionMaxAgeMs;
	}

	private async performAuthentication(): Promise<void> {
		if (this.closed) {
			throw new PortalSessionError('closed');
		}
		this.authenticatedAt = null;
		this.sessionKey?.fill(0);
		this.sessionKey = null;
		this.cookies.clear();

		const loginBody = new URLSearchParams({
			user: `${this.options.schoolId}.${this.options.username}`,
			user2: this.options.username,
			password: this.options.password,
		}).toString();
		const loginUrl = new URL(LOGIN_URL);
		loginUrl.searchParams.set('i', this.options.schoolId);
		const loginStatus = await this.withRequest(
			loginUrl,
			{
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: loginBody,
			},
			async response => {
				const status = response.status;
				await cancelBody(response);
				return status;
			},
		);
		if (!(loginStatus >= 200 && loginStatus < 300) && !isRedirect(loginStatus)) {
			throw new PortalSessionError('authentication-failed', 'login-unexpected-status', loginStatus);
		}

		const connectCookiePresent = this.cookies.header(CONNECT_URL) !== undefined;
		const connectResponse = await this.withRequest(CONNECT_URL, { method: 'HEAD' }, async response => {
			const location = response.headers.get('location');
			const status = response.status;
			await cancelBody(response);
			if (status === 401 || status === 403) {
				throw new PortalSessionError('authentication-failed', 'connect-auth-rejected', status);
			}
			if (!isRedirect(status) || !location) {
				throw new PortalSessionError('authentication-failed', 'connect-invalid-response', status);
			}
			return { location, status };
		});

		let authTarget: URL;
		try {
			authTarget = parseAllowedUrl(connectResponse.location, CONNECT_URL);
		} catch {
			throw new PortalSessionError('authentication-failed', 'connect-redirect-invalid', connectResponse.status);
		}
		if (authTarget.hostname === LOGIN_URL.hostname) {
			const diagnostic = connectCookiePresent
				? 'connect-session-missing-cookie-sent'
				: 'connect-session-missing-no-cookie';
			throw new PortalSessionError('authentication-failed', diagnostic, connectResponse.status);
		}
		if (authTarget.hostname !== START_URL.hostname) {
			throw new PortalSessionError('authentication-failed', 'connect-host-rejected', connectResponse.status);
		}
		await this.getAuthenticationTarget(authTarget);
		await this.performRsaHandshake();
		if (this.closed) {
			throw new PortalSessionError('closed');
		}
		this.authenticatedAt = this.now();
		this.generation++;
	}

	private async getAuthenticationTarget(initialTarget: URL): Promise<void> {
		let target = initialTarget;
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
			const result = await this.withRequest(target, { method: 'GET' }, async response => {
				const location = response.headers.get('location');
				const status = response.status;
				if (status === 401 || status === 403) {
					await cancelBody(response);
					throw new PortalSessionError('authentication-failed', 'start-auth-rejected', status);
				}
				if (isRedirect(status) && isLoginHostRedirect(location ?? '', target)) {
					await cancelBody(response);
					throw new PortalSessionError('authentication-failed', 'start-login-redirect', status);
				}
				if (isRedirect(status)) {
					await cancelBody(response);
					if (!location || redirects === MAX_REDIRECTS) {
						throw new PortalSessionError('authentication-failed', 'start-redirect-incomplete', status);
					}
					let next: URL;
					try {
						next = parseAllowedUrl(location, target);
					} catch {
						throw new PortalSessionError('authentication-failed', 'start-redirect-invalid', status);
					}
					if (next.hostname !== START_URL.hostname) {
						throw new PortalSessionError('authentication-failed', 'start-host-rejected', status);
					}
					return next;
				}
				await cancelBody(response);
				if (status < 200 || status >= 300) {
					throw new PortalSessionError('authentication-failed', 'start-unexpected-status', status);
				}
				return null;
			});
			if (result === null) {
				return;
			}
			target = result;
		}
		throw new PortalSessionError('authentication-failed');
	}

	private async performRsaHandshake(): Promise<void> {
		const publicKeyResponse = await this.withRequest(
			new URL('/ajax.php?f=rsaPublicKey', START_URL),
			{ method: 'POST' },
			response => this.readJsonObject(response, MAX_AUTH_RESPONSE_BYTES, 'rsa-public-key'),
		);
		let publicKey: ReturnType<typeof createPublicKey>;
		let sessionKey: Buffer | undefined;
		let encryptedKey: Buffer;
		try {
			if (typeof publicKeyResponse.publickey !== 'string') {
				throw new Error();
			}
			publicKey = createPublicKey(publicKeyResponse.publickey);
			sessionKey = randomBytes(SESSION_KEY_BYTES);
			encryptedKey = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, sessionKey);
		} catch {
			sessionKey?.fill(0);
			throw new PortalSessionError('handshake-failed', 'rsa-public-key-invalid');
		}
		if (!sessionKey) {
			throw new PortalSessionError('handshake-failed', 'rsa-public-key-invalid');
		}

		const handshakeUrl = new URL('/ajax.php', START_URL);
		handshakeUrl.searchParams.set('f', 'rsaHandshake');
		handshakeUrl.searchParams.set('s', String(randomInt(2000)));
		const handshakeBody = new URLSearchParams({ key: encryptedKey.toString('base64') }).toString();
		let keyRetained = false;
		try {
			const challengeResponse = await this.withRequest(
				handshakeUrl,
				{
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: handshakeBody,
				},
				response => this.readJsonObject(response, MAX_AUTH_RESPONSE_BYTES, 'rsa-handshake'),
			);
			if (this.closed) {
				throw new PortalSessionError('closed');
			}
			if (!verifyChallenge(challengeResponse.challenge, sessionKey)) {
				throw new PortalSessionError('handshake-failed', 'rsa-handshake-invalid');
			}
			this.sessionKey?.fill(0);
			this.sessionKey = sessionKey;
			keyRetained = true;
		} finally {
			if (!keyRetained) {
				sessionKey.fill(0);
			}
		}
	}

	private async readJsonObject(
		response: Response,
		limit: number,
		phase: 'rsa-public-key' | 'rsa-handshake',
	): Promise<Record<string, unknown>> {
		const responseDiagnostic =
			phase === 'rsa-public-key' ? 'rsa-public-key-response-invalid' : 'rsa-handshake-response-invalid';
		if (response.status < 200 || response.status >= 300) {
			const status = response.status;
			await cancelBody(response);
			throw new PortalSessionError('handshake-failed', responseDiagnostic, status);
		}
		let body: Uint8Array;
		try {
			body = await this.readResponseBody(response, limit);
		} catch (error) {
			if (error instanceof ResponseBodyTooLargeError) {
				throw new PortalSessionError('handshake-failed', responseDiagnostic, response.status);
			}
			throw error;
		}
		try {
			const parsed: unknown = JSON.parse(Buffer.from(body).toString('utf8'));
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error();
			}
			return parsed as Record<string, unknown>;
		} catch {
			throw new PortalSessionError('handshake-failed', responseDiagnostic, response.status);
		}
	}

	private async getFollowingRedirects(initialTarget: URL): Promise<PortalResponse> {
		let target = initialTarget;
		for (let redirects = 0; ; redirects++) {
			const next = await this.withRequest(target, { method: 'GET' }, async response => {
				const contentType = response.headers.get('content-type');
				const location = response.headers.get('location');
				if (
					response.status === 401 ||
					(isRedirect(response.status) && isLoginHostRedirect(location ?? '', target))
				) {
					await cancelBody(response);
					return { response: responseResult(response.status, 'session-expired', contentType), target: null };
				}
				if (isRedirect(response.status)) {
					if (!location) {
						await cancelBody(response);
						return { response: responseResult(response.status, 'redirect', contentType), target: null };
					}
					let redirectTarget: URL;
					try {
						redirectTarget = parseAllowedUrl(location, target);
					} catch {
						await cancelBody(response);
						return {
							response: responseResult(response.status, 'blocked-redirect', contentType),
							target: null,
						};
					}
					if (
						redirectTarget.hostname === LOGIN_URL.hostname ||
						redirectTarget.hostname === CONNECT_URL.hostname
					) {
						await cancelBody(response);
						return {
							response: responseResult(response.status, 'session-expired', contentType),
							target: null,
						};
					}
					if (redirectTarget.hostname !== START_URL.hostname || !isSafeReadTarget(redirectTarget)) {
						await cancelBody(response);
						return {
							response: responseResult(response.status, 'blocked-redirect', contentType),
							target: null,
						};
					}
					if (redirects >= MAX_REDIRECTS) {
						await cancelBody(response);
						return {
							response: responseResult(response.status, 'redirect-limit', contentType),
							target: null,
						};
					}
					await cancelBody(response);
					return { response: null, target: redirectTarget };
				}

				if (response.status < 200 || response.status >= 300) {
					await cancelBody(response);
					return {
						response: responseResult(response.status, classifyPortalStatus(response.status), contentType),
						target: null,
					};
				}
				try {
					const rawBody = await this.readResponseBody(response, this.maxResponseBytes);
					const body = decodeEncryptedFragments(rawBody, this.sessionKey);
					if (isLoginPage(body, contentType)) {
						return {
							response: responseResult(401, 'session-expired', contentType),
							target: null,
						};
					}
					return {
						response: responseResult(response.status, 'success', contentType, body, {
							bodyByteLength: rawBody.byteLength,
						}),
						target: null,
					};
				} catch (error) {
					if (error instanceof ResponseBodyTooLargeError) {
						return {
							response: responseResult(response.status, 'response-too-large', contentType, undefined, {
								responseSizeDiagnostic: error.diagnostic,
							}),
							target: null,
						};
					}
					throw error;
				}
			});

			if (next.response) {
				return next.response;
			}
			if (next.target) {
				target = next.target;
			}
		}
	}

	private async readResponseBody(response: Response, limit: number): Promise<Uint8Array> {
		const contentLengthHeader = response.headers.get('content-length');
		const contentLength = Number(contentLengthHeader);
		const declaredContentLength = getSafeContentLength(contentLengthHeader);
		if (Number.isFinite(contentLength) && contentLength > limit) {
			await cancelBody(response);
			throw new ResponseBodyTooLargeError(limit, declaredContentLength, false);
		}
		if (!response.body) {
			return new Uint8Array();
		}

		const reader = response.body.getReader();
		const prefix = contentLengthHeader === null ? Buffer.alloc(MAX_RESPONSE_PREFIX_BYTES) : undefined;
		const chunks: Buffer[] = [];
		let prefixLength = 0;
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (prefix && prefixLength < prefix.length) {
					const prefixChunkLength = Math.min(value.byteLength, prefix.length - prefixLength);
					prefix.set(value.subarray(0, prefixChunkLength), prefixLength);
					prefixLength += prefixChunkLength;
				}
				total += value.byteLength;
				if (total > limit) {
					const prefixClassification = prefix
						? classifyResponsePrefix(prefix.subarray(0, prefixLength))
						: 'not-inspected';
					prefix?.fill(0);
					await reader.cancel();
					throw new ResponseBodyTooLargeError(limit, declaredContentLength, true, prefixClassification);
				}
				chunks.push(Buffer.from(value));
			}
		} finally {
			prefix?.fill(0);
			reader.releaseLock();
		}
		return Buffer.concat(chunks, total);
	}

	private async withRequest<T>(url: URL, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
		if (this.closed) {
			throw new PortalSessionError('closed');
		}
		const safeUrl = parseAllowedUrl(url);
		const headers = new Headers(init.headers);
		headers.set('user-agent', ADAPTER_USER_AGENT);
		const cookieHeader = this.cookies.header(safeUrl);
		if (safeUrl.hostname === START_URL.hostname && this.authenticatedAt !== null) {
			const schoolContextCookieNames = new Set(['sph-login-upstream', 'schulportal_lastschool', 'i']);
			const cookies = (cookieHeader ?? '')
				.split(';')
				.map(cookie => cookie.trim())
				.filter(cookie => cookie && !schoolContextCookieNames.has(cookie.split('=', 1)[0]));
			cookies.push(
				'sph-login-upstream=4',
				`schulportal_lastschool=${this.options.schoolId}`,
				`i=${this.options.schoolId}`,
			);
			headers.set('cookie', cookies.join('; '));
		} else if (cookieHeader) {
			headers.set('cookie', cookieHeader);
		}

		const controller = new AbortController();
		this.activeControllers.add(controller);
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(new PortalSessionError('timeout'));
			}, this.requestTimeoutMs);
		});
		const operation = (async (): Promise<T> => {
			const response = await this.fetchImpl(safeUrl, {
				...init,
				headers,
				redirect: 'manual',
				signal: controller.signal,
			});
			if (this.closed) {
				await cancelBody(response);
				throw new PortalSessionError('closed');
			}
			this.cookies.store(safeUrl, response.headers);
			return consume(response);
		})();
		try {
			return await Promise.race([operation, timeout]);
		} catch (error) {
			if (error instanceof PortalSessionError) {
				throw error;
			}
			throw new PortalSessionError(this.closed ? 'closed' : timedOut ? 'timeout' : 'network-error');
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			this.activeControllers.delete(controller);
		}
	}
}
