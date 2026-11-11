import { constants, createCipheriv, createHash, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { expect } from 'chai';
import { classifyPortalStatus, PortalSession, PortalSessionError } from './portal-session';

const testKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = testKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();

interface RecordedRequest {
	url: URL;
	method: string;
	headers: Headers;
	body: string;
	redirect: string | undefined;
}

interface FakePortalOptions {
	invalidChallenge?: boolean;
	onRead?: (request: RecordedRequest, count: number) => Response;
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

function encryptedChallenge(secret: Buffer, plaintext: Buffer = secret): string {
	const salt = randomBytes(8);
	let material = Buffer.alloc(0);
	let previous = Buffer.alloc(0);
	while (material.length < 48) {
		previous = createHash('md5').update(previous).update(secret).update(salt).digest();
		material = Buffer.concat([material, previous]);
	}
	const cipher = createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([Buffer.from('Salted__'), salt, ciphertext]).toString('base64');
}

function createFakePortal(options: FakePortalOptions = {}): {
	fetchImpl: typeof fetch;
	requests: RecordedRequest[];
	sessionKeys: Buffer[];
} {
	const requests: RecordedRequest[] = [];
	const sessionKeys: Buffer[] = [];
	let readCount = 0;

	const fetchImpl: typeof fetch = async (input, init) => {
		const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
		const method = (init?.method ?? 'GET').toUpperCase();
		const headers = new Headers(init?.headers);
		const body = typeof init?.body === 'string' ? init.body : '';
		const request = { url, method, headers, body, redirect: init?.redirect };
		requests.push(request);
		await Promise.resolve();

		if (url.hostname === 'login.schulportal.hessen.de') {
			const user = new URLSearchParams(body).get('user2') ?? 'unknown';
			const responseHeaders = new Headers({ location: 'https://connect.schulportal.hessen.de/' });
			responseHeaders.append('set-cookie', `sid=${user}; Domain=schulportal.hessen.de; Path=/; Secure; HttpOnly`);
			responseHeaders.append('set-cookie', 'login_only=secret; Path=/; Secure; HttpOnly');
			return new Response(null, { status: 302, headers: responseHeaders });
		}

		if (url.hostname === 'connect.schulportal.hessen.de') {
			return new Response(null, {
				status: 302,
				headers: {
					location: 'https://start.schulportal.hessen.de/auth/complete?ticket=synthetic',
					'set-cookie': 'connect_id=connected; Domain=schulportal.hessen.de; Path=/; Secure; HttpOnly',
				},
			});
		}

		if (url.pathname === '/auth/complete') {
			return new Response(null, { status: 200 });
		}

		if (url.pathname === '/ajax.php' && url.searchParams.get('f') === 'rsaPublicKey') {
			return jsonResponse({ publickey: publicKeyPem });
		}

		if (url.pathname === '/ajax.php' && url.searchParams.get('f') === 'rsaHandshake') {
			const form = new URLSearchParams(body);
			const encryptedKey = Buffer.from(form.get('key') ?? '', 'base64');
			const sessionKey = privateDecrypt(
				{ key: testKeys.privateKey, padding: constants.RSA_PKCS1_PADDING },
				encryptedKey,
			);
			sessionKeys.push(sessionKey);
			const challengeKey = options.invalidChallenge ? Buffer.alloc(sessionKey.length, 0x6a) : sessionKey;
			return jsonResponse({ challenge: encryptedChallenge(sessionKey, challengeKey) });
		}

		if (url.pathname === '/read.php') {
			readCount++;
			return options.onRead?.(request, readCount) ?? jsonResponse({ ok: true });
		}

		return new Response(null, { status: 404 });
	};

	return { fetchImpl, requests, sessionKeys };
}

function makeSession(
	fetchImpl: typeof fetch,
	overrides: Partial<ConstructorParameters<typeof PortalSession>[0]> = {},
): PortalSession {
	return new PortalSession({
		schoolId: '01234',
		username: 'student',
		password: 'synthetic-password',
		fetchImpl,
		...overrides,
	});
}

describe('PortalSession', () => {
	it('sends the verified form login, follows the connect redirect, and validates the RSA/AES challenge', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl, {
			username: 'student+fixture',
			password: 'password & value',
		});

		const result = await session.get('/read.php?view=synthetic');

		expect(result.classification).to.equal('success');
		expect(Buffer.from(result.body).toString('utf8')).to.equal('{"ok":true}');
		expect(server.sessionKeys).to.have.length(1);
		expect(server.sessionKeys[0]).to.have.length(46);
		expect(
			server.requests.map(request => [
				request.method,
				request.url.hostname,
				request.url.pathname,
				request.url.searchParams.get('f'),
			]),
		).to.deep.equal([
			['POST', 'login.schulportal.hessen.de', '/', null],
			['GET', 'connect.schulportal.hessen.de', '/', null],
			['GET', 'start.schulportal.hessen.de', '/auth/complete', null],
			['POST', 'start.schulportal.hessen.de', '/ajax.php', 'rsaPublicKey'],
			['POST', 'start.schulportal.hessen.de', '/ajax.php', 'rsaHandshake'],
			['GET', 'start.schulportal.hessen.de', '/read.php', null],
		]);
		expect(server.requests.every(request => request.redirect === 'manual')).to.equal(true);

		const login = server.requests.find(request => request.url.hostname === 'login.schulportal.hessen.de');
		expect(login).to.exist;
		expect(login?.url.toString()).to.equal('https://login.schulportal.hessen.de/?i=01234');
		expect(login?.method).to.equal('POST');
		expect(login?.headers.get('content-type')).to.equal('application/x-www-form-urlencoded');
		expect(login?.headers.get('user-agent')).to.equal('ioBroker.schulportal-hessen');
		expect(login?.headers.get('user-agent')).not.to.match(/Home Assistant|Lanis-Mobile/i);
		const form = new URLSearchParams(login?.body);
		expect([...form.keys()]).to.deep.equal(['user', 'user2', 'password']);
		expect(form.get('user')).to.equal('01234.student+fixture');
		expect(form.get('user2')).to.equal('student+fixture');
		expect(form.get('password')).to.equal('password & value');

		const connect = server.requests.find(request => request.url.hostname === 'connect.schulportal.hessen.de');
		const authTarget = server.requests.find(request => request.url.pathname === '/auth/complete');
		const publicKeyRequest = server.requests.find(request => request.url.searchParams.get('f') === 'rsaPublicKey');
		const handshakeRequest = server.requests.find(request => request.url.searchParams.get('f') === 'rsaHandshake');
		expect(connect?.method).to.equal('GET');
		expect(connect?.headers.get('cookie')).to.contain('sid=student+fixture');
		expect(connect?.headers.get('cookie')).not.to.contain('login_only=secret');
		expect(authTarget?.method).to.equal('GET');
		expect(authTarget?.headers.get('cookie')).to.contain('connect_id=connected');
		expect(publicKeyRequest?.method).to.equal('POST');
		expect(handshakeRequest?.method).to.equal('POST');
		expect(Number(handshakeRequest?.url.searchParams.get('s'))).to.be.within(0, 1999);
		expect(handshakeRequest?.headers.get('content-type')).to.equal('application/x-www-form-urlencoded');
	});

	it('keeps cookies and crypto keys isolated between client/account instances', async () => {
		const server = createFakePortal();
		const first = makeSession(server.fetchImpl, { username: 'account-one' });
		const second = makeSession(server.fetchImpl, { username: 'account-two' });

		await first.get('/read.php');
		await second.get('/read.php');
		await first.get('/read.php');

		const reads = server.requests.filter(request => request.url.pathname === '/read.php');
		expect(reads).to.have.length(3);
		expect(reads[0].headers.get('cookie')).to.contain('sid=account-one');
		expect(reads[1].headers.get('cookie')).to.contain('sid=account-two');
		expect(reads[2].headers.get('cookie')).to.contain('sid=account-one');
		expect(server.sessionKeys).to.have.length(2);
		expect(server.sessionKeys[0].equals(server.sessionKeys[1])).to.equal(false);
	});

	it('re-authenticates and retries at most once when an authenticated request is expired', async () => {
		const server = createFakePortal({ onRead: () => new Response('private error body', { status: 401 }) });
		const session = makeSession(server.fetchImpl);

		const result = await session.get('/read.php');

		expect(result.classification).to.equal('session-expired');
		expect(result.body).to.have.length(0);
		expect(
			server.requests.filter(request => request.url.hostname === 'login.schulportal.hessen.de'),
		).to.have.length(2);
		expect(server.requests.filter(request => request.url.pathname === '/read.php')).to.have.length(2);
	});

	it('treats a redirect to the login host as expiry and retries with a fresh session', async () => {
		const server = createFakePortal({
			onRead: (_request, count) =>
				count === 1
					? new Response(null, {
							status: 302,
							headers: { location: 'https://login.schulportal.hessen.de/?token=private' },
						})
					: new Response('ok', { status: 200 }),
		});
		const result = await makeSession(server.fetchImpl).get('/read.php');

		expect(result.classification).to.equal('success');
		expect(Buffer.from(result.body).toString('utf8')).to.equal('ok');
		expect(
			server.requests.filter(request => request.url.hostname === 'login.schulportal.hessen.de'),
		).to.have.length(2);
		expect(JSON.stringify(result)).not.to.contain('private');
	});

	it('refreshes a session after the verified maximum age', async () => {
		const server = createFakePortal();
		let now = 0;
		const session = makeSession(server.fetchImpl, { now: () => now, sessionMaxAgeMs: 1000 });

		await session.authenticate();
		now = 1000;
		await session.get('/read.php');

		expect(
			server.requests.filter(request => request.url.hostname === 'login.schulportal.hessen.de'),
		).to.have.length(2);
	});

	it('blocks external redirects and stops redirect loops at the configured bound', async () => {
		const external = createFakePortal({
			onRead: () =>
				new Response(null, { status: 302, headers: { location: 'https://attacker.example/private' } }),
		});
		const externalResult = await makeSession(external.fetchImpl).get('/read.php');
		expect(externalResult.classification).to.equal('blocked-redirect');
		expect(external.requests.some(request => request.url.hostname === 'attacker.example')).to.equal(false);

		const looping = createFakePortal({
			onRead: () => new Response(null, { status: 302, headers: { location: '/read.php' } }),
		});
		const loopResult = await makeSession(looping.fetchImpl).get('/read.php');
		expect(loopResult.classification).to.equal('redirect-limit');
		expect(looping.requests.filter(request => request.url.pathname === '/read.php')).to.have.length(4);
	});

	it('rejects unverified mutating, message, download, and non-portal targets before making requests', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl);
		for (const path of [
			'//attacker.example/read',
			'https://attacker.example/read',
			'/nachrichten.php?a=read',
			'/index.php?logout=all',
			'/download.php?file=report',
			'/upload.php',
			'/ajax.php?f=rsaHandshake',
		]) {
			let error: unknown;
			try {
				await session.get(path);
			} catch (caught) {
				error = caught;
			}
			expect(error).to.be.instanceOf(PortalSessionError);
			expect((error as PortalSessionError).code).to.equal('invalid-target');
		}
		expect(server.requests).to.have.length(0);
	});

	it('rejects an invalid RSA challenge without retaining an authenticated session', async () => {
		const server = createFakePortal({ invalidChallenge: true });
		const session = makeSession(server.fetchImpl);
		let error: unknown;
		try {
			await session.authenticate();
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).code).to.equal('handshake-failed');
		expect(server.requests.some(request => request.url.pathname === '/read.php')).to.equal(false);
	});

	it('enforces request timeouts even when a fetch implementation ignores abort', async () => {
		const fetchImpl: typeof fetch = () =>
			new Promise<Response>(() => {
				// Deliberately ignore abort to verify the timeout race.
			});
		const session = makeSession(fetchImpl, { requestTimeoutMs: 10 });
		let error: unknown;
		try {
			await session.authenticate();
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).code).to.equal('timeout');
		expect((error as Error).message).not.to.contain('private');
	});

	it('sanitizes transport errors rather than exposing raw error messages', async () => {
		const fetchImpl: typeof fetch = () => Promise.reject(new Error('private URL and password'));
		const session = makeSession(fetchImpl);
		let error: unknown;
		try {
			await session.authenticate();
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).code).to.equal('network-error');
		expect((error as Error).message).not.to.contain('private');
	});

	it('bounds response size and returns generic HTTP classifications', async () => {
		const server = createFakePortal({ onRead: () => new Response('x'.repeat(32), { status: 200 }) });
		const result = await makeSession(server.fetchImpl, { maxResponseBytes: 8 }).get('/read.php');
		expect(result.classification).to.equal('response-too-large');
		expect(result.body).to.have.length(0);
		expect(classifyPortalStatus(403)).to.equal('forbidden');
		expect(classifyPortalStatus(404)).to.equal('not-found');
		expect(classifyPortalStatus(429)).to.equal('rate-limited');
		expect(classifyPortalStatus(503)).to.equal('server-error');
	});
});
