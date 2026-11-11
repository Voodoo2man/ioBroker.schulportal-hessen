import {
	constants,
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
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const SESSION_KEY_BYTES = 46;
const CHALLENGE_BYTES = 48;
const COOKIE_PARENT_DOMAIN = 'schulportal.hessen.de';
const MAX_COOKIE_COUNT = 100;
const MAX_COOKIE_VALUE_BYTES = 4096;
const MAX_COOKIE_HEADER_BYTES = 16 * 1024;
const MAX_USERNAME_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 4096;

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

export type PortalSessionErrorCode =
	'invalid-config' | 'invalid-target' | 'timeout' | 'network-error' | 'authentication-failed' | 'handshake-failed';

const ERROR_MESSAGES: Record<PortalSessionErrorCode, string> = {
	'invalid-config': 'Portal session configuration is invalid.',
	'invalid-target': 'Portal request target is not allowed.',
	timeout: 'Portal request timed out.',
	'network-error': 'Portal request failed.',
	'authentication-failed': 'Portal authentication failed.',
	'handshake-failed': 'Portal session handshake failed.',
};

/** Safe error with a stable code and a message that excludes transport details. */
export class PortalSessionError extends Error {
	/**
	 * Create an error that does not include credentials, URLs, or raw network messages.
	 *
	 * @param code Stable public error code.
	 */
	constructor(public readonly code: PortalSessionErrorCode) {
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
	constructor() {
		super();
		this.name = 'ResponseBodyTooLargeError';
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
					(cookie.hostOnly ? url.hostname === cookie.domain : domainMatches(url.hostname, cookie.domain)) &&
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
	return (ALLOWED_HOSTS.has(domain) || domain === COOKIE_PARENT_DOMAIN) && domainMatches(sourceHost, domain);
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
	if (url.hostname !== START_URL.hostname) {
		throw new PortalSessionError('invalid-target');
	}
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname).toLowerCase();
	} catch {
		throw new PortalSessionError('invalid-target');
	}
	const isLogoutAll = [...url.searchParams].some(
		([key, value]) => key.toLowerCase() === 'logout' && value.toLowerCase() === 'all',
	);
	if (
		pathname === '/nachrichten.php' ||
		pathname.startsWith('/nachrichten/') ||
		pathname === '/ajax.php' ||
		/(?:^|\/)(?:upload|download)(?:\.php)?(?:\/|$)/.test(pathname) ||
		(pathname === '/index.php' && isLogoutAll)
	) {
		throw new PortalSessionError('invalid-target');
	}
	return url;
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
): PortalResponse {
	return { status, classification, contentType, body };
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

/** An isolated, read-only authenticated session for a single Schulportal account. */
export class PortalSession {
	private readonly cookies: PortalCookieJar;
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;
	private readonly requestTimeoutMs: number;
	private readonly sessionMaxAgeMs: number;
	private readonly maxResponseBytes: number;
	private sessionKey: Buffer | null = null;
	private authenticatedAt: number | null = null;
	private generation = 0;
	private authenticationInFlight: Promise<void> | null = null;

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
		await this.authenticateIfNeeded(false);
		let observedGeneration = this.generation;

		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await this.getFollowingRedirects(target);
			if (result.classification !== 'session-expired' || attempt === 1) {
				return result;
			}

			if (this.generation === observedGeneration) {
				await this.authenticateIfNeeded(true);
			} else {
				await this.authenticateIfNeeded(false);
			}
			observedGeneration = this.generation;
		}

		return responseResult(401, 'session-expired');
	}

	private authenticateIfNeeded(force: boolean): Promise<void> {
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
			throw new PortalSessionError('authentication-failed');
		}

		const connectLocation = await this.withRequest(CONNECT_URL, { method: 'GET' }, async response => {
			const location = response.headers.get('location');
			const status = response.status;
			await cancelBody(response);
			if (status === 401 || status === 403 || !isRedirect(status) || !location) {
				throw new PortalSessionError('authentication-failed');
			}
			return location;
		});

		let authTarget: URL;
		try {
			authTarget = parseAllowedUrl(connectLocation, CONNECT_URL);
		} catch {
			throw new PortalSessionError('authentication-failed');
		}
		if (authTarget.hostname !== START_URL.hostname) {
			throw new PortalSessionError('authentication-failed');
		}
		await this.getAuthenticationTarget(authTarget);
		await this.performRsaHandshake();
		this.authenticatedAt = this.now();
		this.generation++;
	}

	private async getAuthenticationTarget(initialTarget: URL): Promise<void> {
		let target = initialTarget;
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
			const result = await this.withRequest(target, { method: 'GET' }, async response => {
				const location = response.headers.get('location');
				const status = response.status;
				if (
					status === 401 ||
					status === 403 ||
					(isRedirect(status) && isLoginHostRedirect(location ?? '', target))
				) {
					await cancelBody(response);
					throw new PortalSessionError('authentication-failed');
				}
				if (isRedirect(status)) {
					await cancelBody(response);
					if (!location || redirects === MAX_REDIRECTS) {
						throw new PortalSessionError('authentication-failed');
					}
					let next: URL;
					try {
						next = parseAllowedUrl(location, target);
					} catch {
						throw new PortalSessionError('authentication-failed');
					}
					if (next.hostname !== START_URL.hostname) {
						throw new PortalSessionError('authentication-failed');
					}
					return next;
				}
				await cancelBody(response);
				if (status < 200 || status >= 300) {
					throw new PortalSessionError('authentication-failed');
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
			response => this.readJsonObject(response, MAX_AUTH_RESPONSE_BYTES),
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
			throw new PortalSessionError('handshake-failed');
		}
		if (!sessionKey) {
			throw new PortalSessionError('handshake-failed');
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
				response => this.readJsonObject(response, MAX_AUTH_RESPONSE_BYTES),
			);
			if (!verifyChallenge(challengeResponse.challenge, sessionKey)) {
				throw new PortalSessionError('handshake-failed');
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

	private async readJsonObject(response: Response, limit: number): Promise<Record<string, unknown>> {
		if (response.status < 200 || response.status >= 300) {
			await cancelBody(response);
			throw new PortalSessionError('handshake-failed');
		}
		let body: Uint8Array;
		try {
			body = await this.readResponseBody(response, limit);
		} catch (error) {
			if (error instanceof ResponseBodyTooLargeError) {
				throw new PortalSessionError('handshake-failed');
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
			throw new PortalSessionError('handshake-failed');
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
					const body = await this.readResponseBody(response, this.maxResponseBytes);
					return { response: responseResult(response.status, 'success', contentType, body), target: null };
				} catch (error) {
					if (error instanceof ResponseBodyTooLargeError) {
						return {
							response: responseResult(response.status, 'response-too-large', contentType),
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
		const contentLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(contentLength) && contentLength > limit) {
			await cancelBody(response);
			throw new ResponseBodyTooLargeError();
		}
		if (!response.body) {
			return new Uint8Array();
		}

		const reader = response.body.getReader();
		const chunks: Buffer[] = [];
		let total = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				total += value.byteLength;
				if (total > limit) {
					await reader.cancel();
					throw new ResponseBodyTooLargeError();
				}
				chunks.push(Buffer.from(value));
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks, total);
	}

	private async withRequest<T>(url: URL, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
		const safeUrl = parseAllowedUrl(url);
		const headers = new Headers(init.headers);
		headers.set('user-agent', ADAPTER_USER_AGENT);
		const cookieHeader = this.cookies.header(safeUrl);
		if (cookieHeader) {
			headers.set('cookie', cookieHeader);
		}

		const controller = new AbortController();
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
			this.cookies.store(safeUrl, response.headers);
			return consume(response);
		})();
		try {
			return await Promise.race([operation, timeout]);
		} catch (error) {
			if (error instanceof PortalSessionError) {
				throw error;
			}
			throw new PortalSessionError(timedOut ? 'timeout' : 'network-error');
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}
}
