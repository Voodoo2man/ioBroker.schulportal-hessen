import {
	constants,
	createCipheriv,
	createDecipheriv,
	createHash,
	generateKeyPairSync,
	privateDecrypt,
	randomBytes,
} from 'node:crypto';
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
	loginCookieDomain?: string;
	loginCookieHostOnly?: boolean;
	onRead?: (request: RecordedRequest, count: number, sessionKeys: Buffer[]) => Response;
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

function decryptOpenSslPayload(encoded: string, secret: Buffer): string {
	const payload = Buffer.from(encoded, 'base64');
	let material = Buffer.alloc(0);
	let previous = Buffer.alloc(0);
	const salt = payload.subarray(8, 16);
	while (material.length < 48) {
		previous = createHash('md5').update(previous).update(secret).update(salt).digest();
		material = Buffer.concat([material, previous]);
	}
	const decipher = createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
	return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString('utf8');
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
			const sidCookie = options.loginCookieHostOnly
				? `sid=${user}; Path=/; Secure; HttpOnly`
				: `sid=${user}; Domain=${options.loginCookieDomain ?? 'schulportal.hessen.de'}; Path=/; Secure; HttpOnly`;
			responseHeaders.append('set-cookie', sidCookie);
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

		if (
			url.hostname === 'start.schulportal.hessen.de' &&
			[
				'/stundenplan.php',
				'/kalender.php',
				'/vertretungsplan.php',
				'/meinunterricht.php',
				'/dateispeicher.php',
				'/nachrichten.php',
			].includes(url.pathname) &&
			(method === 'GET' || method === 'POST')
		) {
			readCount++;
			return options.onRead?.(request, readCount, sessionKeys) ?? jsonResponse({ ok: true });
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
	it('uses HEAD for connect, completes authentication, and validates the RSA/AES challenge', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl, {
			username: 'student+fixture',
			password: 'password & value',
		});

		const result = await session.get('/stundenplan.php');

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
			['HEAD', 'connect.schulportal.hessen.de', '/', null],
			['GET', 'start.schulportal.hessen.de', '/auth/complete', null],
			['POST', 'start.schulportal.hessen.de', '/ajax.php', 'rsaPublicKey'],
			['POST', 'start.schulportal.hessen.de', '/ajax.php', 'rsaHandshake'],
			['GET', 'start.schulportal.hessen.de', '/stundenplan.php', null],
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
		expect(connect?.method).to.equal('HEAD');
		expect(connect?.headers.get('cookie')).to.contain('sid=student+fixture');
		expect(connect?.headers.get('cookie')).not.to.contain('login_only=secret');
		expect(authTarget?.method).to.equal('GET');
		expect(authTarget?.headers.get('cookie')).to.contain('connect_id=connected');
		expect(publicKeyRequest?.method).to.equal('POST');
		expect(handshakeRequest?.method).to.equal('POST');
		expect(Number(handshakeRequest?.url.searchParams.get('s'))).to.be.within(0, 1999);
		expect(handshakeRequest?.headers.get('content-type')).to.equal('application/x-www-form-urlencoded');
	});

	it('sends a verified hessen.de parent cookie only to allowed portal hosts', async () => {
		const server = createFakePortal({ loginCookieDomain: 'hessen.de' });
		const session = makeSession(server.fetchImpl);

		const result = await session.get('/stundenplan.php');
		const connect = server.requests.find(request => request.url.hostname === 'connect.schulportal.hessen.de');

		expect(result.classification).to.equal('success');
		expect(connect?.headers.get('cookie')).to.contain('sid=student');
		expect(connect?.headers.get('cookie')).not.to.contain('login_only=secret');
	});

	it('forwards only the host-only sid cookie between exact portal authentication hosts', async () => {
		const server = createFakePortal({ loginCookieHostOnly: true });
		const session = makeSession(server.fetchImpl);

		await session.get('/stundenplan.php');

		const connect = server.requests.find(request => request.url.hostname === 'connect.schulportal.hessen.de');
		const authTarget = server.requests.find(request => request.url.pathname === '/auth/complete');
		const timetable = server.requests.find(request => request.url.pathname === '/stundenplan.php');

		expect(connect?.headers.get('cookie')).to.contain('sid=student');
		expect(authTarget?.headers.get('cookie')).to.contain('sid=student');
		expect(timetable?.headers.get('cookie')).to.contain('sid=student');
		expect(connect?.headers.get('cookie')).not.to.contain('login_only=secret');
		expect(timetable?.headers.get('cookie')).not.to.contain('login_only=secret');
	});

	it('sends the selected school context only to start-host requests', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl);

		await session.get('/stundenplan.php');

		const login = server.requests.find(request => request.url.hostname === 'login.schulportal.hessen.de');
		const connect = server.requests.find(request => request.url.hostname === 'connect.schulportal.hessen.de');
		const authTarget = server.requests.find(request => request.url.pathname === '/auth/complete');
		const timetable = server.requests.find(request => request.url.pathname === '/stundenplan.php');
		const timetableCookies = timetable?.headers.get('cookie') ?? '';

		expect(login?.headers.get('cookie') ?? '').not.to.contain('sph-login-upstream=4');
		expect(connect?.headers.get('cookie') ?? '').not.to.contain('schulportal_lastschool=01234');
		expect(authTarget?.headers.get('cookie') ?? '').not.to.contain('schulportal_lastschool=01234');
		expect(timetableCookies).to.contain('sph-login-upstream=4');
		expect(timetableCookies).to.contain('schulportal_lastschool=01234');
		expect(timetableCookies).to.contain('i=01234');
		expect(timetableCookies).to.contain('sid=student');
	});

	it('reports a safe connection-phase code and HTTP status when connect rejects authentication', async () => {
		const server = createFakePortal();
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
			if (url.hostname === 'connect.schulportal.hessen.de') {
				return new Response(null, { status: 403 });
			}
			return server.fetchImpl(input, init);
		};
		const session = makeSession(fetchImpl, { username: 'private-user', password: 'private-password' });

		let error: unknown;
		try {
			await session.authenticate();
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).code).to.equal('authentication-failed');
		expect((error as PortalSessionError).diagnosticCode).to.equal('connect-auth-rejected');
		expect((error as PortalSessionError).httpStatus).to.equal(403);
		expect((error as Error).message).not.to.contain('private-user');
		expect((error as Error).message).not.to.contain('private-password');
	});

	it('distinguishes a connect redirect to the login page from an unexpected host', async () => {
		const server = createFakePortal();
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
			if (url.hostname === 'connect.schulportal.hessen.de') {
				return new Response(null, {
					status: 302,
					headers: { location: 'https://login.schulportal.hessen.de/' },
				});
			}
			return server.fetchImpl(input, init);
		};
		const session = makeSession(fetchImpl);

		let error: unknown;
		try {
			await session.authenticate();
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).diagnosticCode).to.equal('connect-session-missing-cookie-sent');
		expect((error as PortalSessionError).httpStatus).to.equal(302);
	});

	it('reports when login did not produce a cookie for the connect host', async () => {
		const server = createFakePortal();
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
			if (url.hostname === 'login.schulportal.hessen.de') {
				return new Response(null, {
					status: 302,
					headers: { location: 'https://connect.schulportal.hessen.de/' },
				});
			}
			if (url.hostname === 'connect.schulportal.hessen.de') {
				return new Response(null, {
					status: 302,
					headers: { location: 'https://login.schulportal.hessen.de/' },
				});
			}
			return server.fetchImpl(input, init);
		};
		const session = makeSession(fetchImpl);

		let error: unknown;
		try {
			await session.authenticate();
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).diagnosticCode).to.equal('connect-session-missing-no-cookie');
	});

	it('sends only the verified read-only calendar and substitution forms', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl);

		const calendar = await session.postRead({ type: 'calendar-events', start: '2026-05-01', end: '2026-05-31' });
		const substitutions = await session.postRead({
			type: 'substitution-day',
			date: '06.05.2026',
			portalTag: '06_05_2026',
		});

		expect(calendar.classification).to.equal('success');
		expect(substitutions.classification).to.equal('success');
		const posts = server.requests.filter(
			request =>
				request.method === 'POST' && ['/kalender.php', '/vertretungsplan.php'].includes(request.url.pathname),
		);
		expect(posts.map(request => request.url.pathname)).to.deep.equal(['/kalender.php', '/vertretungsplan.php']);
		const calendarForm = new URLSearchParams(posts[0].body);
		expect([...calendarForm.entries()]).to.deep.equal([
			['f', 'getEvents'],
			['start', '2026-05-01'],
			['end', '2026-05-31'],
			['s', ''],
		]);
		expect([...posts[0].url.searchParams.entries()]).to.deep.equal([
			['f', 'getEvents'],
			['s', ''],
			['start', '2026-05-01'],
			['end', '2026-05-31'],
		]);
		expect(posts[0].headers.get('accept')).to.equal('*/*');
		expect(posts[0].headers.get('content-type')).to.equal('application/x-www-form-urlencoded; charset=UTF-8');
		expect(posts[0].headers.get('sec-fetch-dest')).to.equal('empty');
		expect(posts[0].headers.get('sec-fetch-mode')).to.equal('cors');
		expect(posts[0].headers.get('sec-fetch-site')).to.equal('same-origin');
		expect(posts[1].url.searchParams.get('a')).to.equal('my');
		expect(posts[1].headers.get('x-requested-with')).to.equal('XMLHttpRequest');
		expect([...new URLSearchParams(posts[1].body).entries()]).to.deep.equal([
			['tag', '06_05_2026'],
			['ganzerPlan', 'true'],
		]);
	});

	it('retrieves encrypted message headers without requesting or exposing message bodies', async () => {
		const server = createFakePortal({
			onRead: (request, _count, sessionKeys) => {
				if (request.url.pathname !== '/nachrichten.php') {
					return jsonResponse({ ok: true });
				}
				const rows = [
					{
						Uniquid: 'message-123',
						Betreff: 'Schedule update',
						kuerzel: 'AB',
						SenderName: 'Synthetic Sender',
						Datum: '2026-05-06',
						unread: 1,
						Papierkorb: 'nein',
						Inhalt: 'private body must not be returned',
					},
				];
				return jsonResponse({
					rows: encryptedChallenge(sessionKeys[0], Buffer.from(JSON.stringify(rows), 'utf8')),
				});
			},
		});
		const session = makeSession(server.fetchImpl);

		const response = await session.postRead({ type: 'message-headers' });
		const metadata = JSON.parse(Buffer.from(response.body).toString('utf8')) as Record<string, unknown>[];

		expect(response.classification).to.equal('success');
		expect(metadata).to.have.length(1);
		expect(metadata[0]).to.include({
			subject: 'Schedule update',
			senderShortName: 'AB',
			senderName: 'Synthetic Sender',
			date: '2026-05-06',
			unread: true,
			hidden: false,
		});
		expect(metadata[0].id).to.be.a('string').and.to.have.length(64);
		expect(JSON.stringify(metadata)).not.to.contain('private body');
		const request = server.requests.find(item => item.url.pathname === '/nachrichten.php');
		expect(request?.method).to.equal('POST');
		expect(request?.url.search).to.equal('');
		expect(request?.headers.get('accept')).to.equal('*/*');
		expect(request?.headers.get('content-type')).to.equal('application/x-www-form-urlencoded; charset=UTF-8');
		expect(request?.headers.get('sec-fetch-dest')).to.equal('empty');
		expect(request?.headers.get('sec-fetch-mode')).to.equal('cors');
		expect(request?.headers.get('sec-fetch-site')).to.equal('same-origin');
		expect(request?.headers.get('x-requested-with')).to.equal('XMLHttpRequest');
		expect([...new URLSearchParams(request?.body).entries()]).to.deep.equal([
			['a', 'headers'],
			['getType', 'All'],
			['last', '0'],
		]);
		expect(server.requests.some(item => new URLSearchParams(item.body).get('a') === 'read')).to.equal(false);
	});

	it('encrypts a validated visible message ID and returns only hashed conversation IDs', async () => {
		const conversation = {
			Uniquid: 'message-123',
			Datum: '06.05.2026',
			username: 'Synthetic Sender',
			own: false,
			Inhalt: '<p>Hello</p>',
			reply: [
				{
					Uniquid: 'reply-456',
					Datum: '07.05.2026',
					username: 'Other Sender',
					own: true,
					Inhalt: 'Reply text',
				},
			],
			groupOnly: 'ja',
			privateAnswerOnly: 'nein',
			noAnswerAllowed: 'nein',
			statistik: { teilnehmer: 1, betreuer: 2, eltern: 3 },
		};
		const server = createFakePortal({
			onRead: (request, _count, sessionKeys) => {
				if (request.url.pathname !== '/nachrichten.php') {
					return jsonResponse({ ok: true });
				}
				if (request.url.searchParams.get('a') === 'read') {
					return jsonResponse({
						message: encryptedChallenge(sessionKeys[0], Buffer.from(JSON.stringify(conversation), 'utf8')),
						time: 1_700_000_000_000,
					});
				}
				return jsonResponse({
					rows: encryptedChallenge(
						sessionKeys[0],
						Buffer.from(
							JSON.stringify([
								{ Uniquid: 'message-123', Datum: '06.05.2026', unread: 1, Papierkorb: 'nein' },
								{ Uniquid: 'hidden-789', Datum: '05.05.2026', unread: 0, Papierkorb: 'ja' },
							]),
							'utf8',
						),
					),
				});
			},
		});
		const session = makeSession(server.fetchImpl);
		const headers = await session.postRead({ type: 'message-headers' });
		const headerRows = JSON.parse(Buffer.from(headers.body).toString('utf8')) as Array<Record<string, unknown>>;
		const messageHash = createHash('sha256').update('message-123').digest('hex');
		const hiddenHash = createHash('sha256').update('hidden-789').digest('hex');

		let hiddenError: unknown;
		try {
			await session.postRead({ type: 'message-detail', messageIdHash: hiddenHash });
		} catch (error) {
			hiddenError = error;
		}
		const detail = await session.postRead({ type: 'message-detail', messageIdHash: messageHash });
		const detailFields = JSON.parse(Buffer.from(detail.body).toString('utf8')) as Record<string, unknown>;
		const readRequest = server.requests.find(request => request.url.searchParams.get('a') === 'read');
		const form = new URLSearchParams(readRequest?.body);

		expect(headerRows.map(row => row.id)).to.deep.equal([messageHash, hiddenHash]);
		expect(hiddenError).to.be.instanceOf(PortalSessionError);
		expect((hiddenError as PortalSessionError).code).to.equal('invalid-target');
		expect(readRequest?.url.searchParams.get('msg')).to.equal('message-123');
		expect(form.get('a')).to.equal('read');
		expect(decryptOpenSslPayload(form.get('uniqid') ?? '', server.sessionKeys[0])).to.equal('message-123');
		expect(detailFields).to.include({
			id: messageHash,
			date: '06.05.2026',
			username: 'Synthetic Sender',
			own: false,
			content: '<p>Hello</p>',
			time: 1_700_000_000_000,
			groupChat: true,
			onlyPrivateAnswers: false,
			noReply: false,
		});
		expect(detailFields.replies).to.deep.equal([
			{
				id: createHash('sha256').update('reply-456').digest('hex'),
				date: '07.05.2026',
				username: 'Other Sender',
				own: true,
				content: 'Reply text',
			},
		]);
		expect(JSON.stringify(detailFields)).not.to.contain('message-123');
		expect(JSON.stringify(detailFields)).not.to.contain('reply-456');
		expect(server.requests.filter(request => request.url.searchParams.get('a') === 'read')).to.have.length(1);
	});

	it('rejects malformed detail wrappers with safe diagnostics', async () => {
		const server = createFakePortal({
			onRead: (request, _count, sessionKeys) => {
				if (request.url.pathname !== '/nachrichten.php') {
					return jsonResponse({ ok: true });
				}
				return request.url.searchParams.get('a') === 'read'
					? jsonResponse({ message: 'private-encrypted-detail', time: 'invalid' })
					: jsonResponse({
							rows: encryptedChallenge(
								sessionKeys[0],
								Buffer.from(
									JSON.stringify([{ Uniquid: 'message-123', unread: 1, Papierkorb: 'nein' }]),
								),
							),
						});
			},
		});
		const session = makeSession(server.fetchImpl);
		const headers = await session.postRead({ type: 'message-headers' });
		const row = JSON.parse(Buffer.from(headers.body).toString('utf8'))[0] as Record<string, unknown>;
		let error: unknown;
		try {
			await session.postRead({ type: 'message-detail', messageIdHash: String(row.id) });
		} catch (caught) {
			error = caught;
		}

		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).diagnosticCode).to.equal('message-detail-wrapper-invalid');
		expect((error as Error).message).not.to.contain('private-encrypted-detail');
	});

	it('reports a safe decryption phase for malformed encrypted message-header rows', async () => {
		const rowsPayload = Buffer.concat([Buffer.from('Salted__'), Buffer.alloc(8, 0x11)]).toString('base64');
		const responseContent = 'private-response-content';
		const messageText = 'private-message-text';
		const responseBody = JSON.stringify({ rows: rowsPayload, responseContent, message: messageText });
		const server = createFakePortal({
			onRead: () => new Response(responseBody, { headers: { 'content-type': 'application/json' } }),
		});
		const session = makeSession(server.fetchImpl);

		let error: unknown;
		try {
			await session.postRead({ type: 'message-headers' });
		} catch (caught) {
			error = caught;
		}
		expect(error).to.be.instanceOf(PortalSessionError);
		const sessionError = error as PortalSessionError;
		expect(sessionError.code).to.equal('decode-failed');
		expect(sessionError.diagnosticCode).to.equal('message-headers-decryption-failed');
		expect(sessionError.message).to.equal('Portal response decoding failed.');
		const exposedError = [
			sessionError.message,
			sessionError.stack,
			sessionError.code,
			sessionError.diagnosticCode,
			JSON.stringify(sessionError),
		].join(' ');
		expect(exposedError).not.to.contain(responseBody);
		expect(exposedError).not.to.contain(rowsPayload);
		expect(exposedError).not.to.contain(responseContent);
		expect(exposedError).not.to.contain(messageText);
	});

	it('reports safe diagnostics for malformed and incomplete message-header wrappers', async () => {
		for (const testCase of [
			{ body: 'private-malformed-wrapper-response', diagnosticCode: 'message-headers-wrapper-invalid' },
			{
				body: JSON.stringify({ message: 'private-wrapper-message-text' }),
				diagnosticCode: 'message-headers-rows-missing',
			},
		] as const) {
			const server = createFakePortal({
				onRead: () => new Response(testCase.body, { headers: { 'content-type': 'application/json' } }),
			});
			const session = makeSession(server.fetchImpl);
			let error: unknown;
			try {
				await session.postRead({ type: 'message-headers' });
			} catch (caught) {
				error = caught;
			}

			expect(error).to.be.instanceOf(PortalSessionError);
			const sessionError = error as PortalSessionError;
			expect(sessionError.code).to.equal('decode-failed');
			expect(sessionError.diagnosticCode).to.equal(testCase.diagnosticCode);
			expect(sessionError.message).not.to.contain(testCase.body);
			expect(sessionError.stack).not.to.contain(testCase.body);
		}
	});

	it('re-authenticates an expired message-header response before decoding', async () => {
		const server = createFakePortal({
			onRead: (request, count, sessionKeys) => {
				if (request.url.pathname !== '/nachrichten.php') {
					return jsonResponse({ ok: true });
				}
				if (count === 1) {
					return new Response('<form><input name="user2"><input name="password"></form>', {
						headers: { 'content-type': 'text/html' },
					});
				}
				return jsonResponse({ rows: encryptedChallenge(sessionKeys[1], Buffer.from('[]', 'utf8')) });
			},
		});
		const session = makeSession(server.fetchImpl);

		const response = await session.postRead({ type: 'message-headers' });

		expect(response.classification).to.equal('success');
		expect(Buffer.from(response.body).toString('utf8')).to.equal('[]');
		expect(server.sessionKeys).to.have.length(2);
		expect(server.requests.filter(request => request.url.pathname === '/nachrichten.php')).to.have.length(2);
	});

	it('allows only validated read-only lesson detail requests', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl);

		const result = await session.get('/meinunterricht.php?a=view&id=123&cacheBreaker=1700000000000&jump=no');

		expect(result.classification).to.equal('success');
		const read = server.requests.find(request => request.url.pathname === '/meinunterricht.php');
		expect(read).to.exist;
		if (!read) {
			return;
		}
		expect(read.method).to.equal('GET');
		expect([...read.url.searchParams.entries()]).to.deep.equal([
			['a', 'view'],
			['id', '123'],
			['cacheBreaker', '1700000000000'],
			['jump', 'no'],
		]);

		const lessonList = await session.get('/meinunterricht.php?cacheBreaker=1700000000000');
		const fileRoot = await session.get('/dateispeicher.php?a=view&folder=0');
		const schoolCalendar = await session.get('/kalender.php?a=export&export=csv&year=2025');
		expect(lessonList.classification).to.equal('success');
		expect(fileRoot.classification).to.equal('success');
		expect(schoolCalendar.classification).to.equal('success');
		expect(
			server.requests.some(
				request => request.url.pathname === '/dateispeicher.php' && request.url.search === '?a=view&folder=0',
			),
		).to.equal(true);

		for (const path of [
			'/meinunterricht.php?a=edit&id=123',
			'/meinunterricht.php?a=view&id=not-a-number',
			'/meinunterricht.php?a=view&id=123&cachebreaker=1700000000000',
			'/meinunterricht.php?a=view&id=123&unexpected=yes',
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
	});

	it('keeps cookies and crypto keys isolated between client/account instances', async () => {
		const server = createFakePortal();
		const first = makeSession(server.fetchImpl, { username: 'account-one' });
		const second = makeSession(server.fetchImpl, { username: 'account-two' });

		await first.get('/stundenplan.php');
		await second.get('/stundenplan.php');
		await first.get('/stundenplan.php');

		const reads = server.requests.filter(request => request.url.pathname === '/stundenplan.php');
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

		const result = await session.get('/stundenplan.php');

		expect(result.classification).to.equal('session-expired');
		expect(result.body).to.have.length(0);
		expect(
			server.requests.filter(request => request.url.hostname === 'login.schulportal.hessen.de'),
		).to.have.length(2);
		expect(server.requests.filter(request => request.url.pathname === '/stundenplan.php')).to.have.length(2);
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
		const result = await makeSession(server.fetchImpl).get('/stundenplan.php');

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
		await session.get('/stundenplan.php');

		expect(
			server.requests.filter(request => request.url.hostname === 'login.schulportal.hessen.de'),
		).to.have.length(2);
	});

	it('recognizes a 200 login page as an expired session and retries once', async () => {
		const server = createFakePortal({
			onRead: (_request, count) =>
				count === 1
					? new Response('<html><input name="user2"><input name="password"></html>', {
							headers: { 'content-type': 'text/html' },
						})
					: jsonResponse({ ok: true }),
		});

		const result = await makeSession(server.fetchImpl).get('/stundenplan.php');

		expect(result.classification).to.equal('success');
		expect(server.requests.filter(request => request.url.pathname === '/stundenplan.php')).to.have.length(2);
		expect(
			server.requests.filter(request => request.url.hostname === 'login.schulportal.hessen.de'),
		).to.have.length(2);
	});

	it('recognizes the portal forward page login warning as an expired session', async () => {
		const server = createFakePortal({
			onRead: (_request, count) =>
				count === 1
					? new Response(
							'<html><body><h1>Login nötig</h1><p>Um auf das gewünschte Tool zuzugreifen, muss man eingeloggt sein.</p><table></table></body></html>',
							{ headers: { 'content-type': 'text/html' } },
						)
					: jsonResponse({ ok: true }),
		});

		const result = await makeSession(server.fetchImpl).get('/stundenplan.php');

		expect(result.classification).to.equal('success');
		expect(server.requests.filter(request => request.url.pathname === '/stundenplan.php')).to.have.length(2);
		expect(
			server.requests.filter(request => request.url.hostname === 'login.schulportal.hessen.de'),
		).to.have.length(2);
	});

	it('decrypts tagged HTML with the authenticated session key and rejects invalid ciphertext', async () => {
		const server = createFakePortal({
			onRead: () =>
				new Response(
					`<div><encoded>${encryptedChallenge(server.sessionKeys[0], Buffer.from('<b>fixture</b>'))}</encoded></div>`,
					{ headers: { 'content-type': 'text/html' } },
				),
		});
		const session = makeSession(server.fetchImpl);
		const result = await session.get('/stundenplan.php');
		expect(Buffer.from(result.body).toString('utf8')).to.equal('<div><b>fixture</b></div>');

		const invalid = createFakePortal({
			onRead: () =>
				new Response('<encoded>not-valid-ciphertext</encoded>', { headers: { 'content-type': 'text/html' } }),
		});
		let error: unknown;
		try {
			await makeSession(invalid.fetchImpl).get('/stundenplan.php');
		} catch (caught) {
			error = caught;
		}
		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).code).to.equal('decode-failed');
	});

	it('blocks external redirects and stops redirect loops at the configured bound', async () => {
		const external = createFakePortal({
			onRead: () =>
				new Response(null, { status: 302, headers: { location: 'https://attacker.example/private' } }),
		});
		const externalResult = await makeSession(external.fetchImpl).get('/stundenplan.php');
		expect(externalResult.classification).to.equal('blocked-redirect');
		expect(external.requests.some(request => request.url.hostname === 'attacker.example')).to.equal(false);

		const looping = createFakePortal({
			onRead: () => new Response(null, { status: 302, headers: { location: '/stundenplan.php' } }),
		});
		const loopResult = await makeSession(looping.fetchImpl).get('/stundenplan.php');
		expect(loopResult.classification).to.equal('redirect-limit');
		expect(looping.requests.filter(request => request.url.pathname === '/stundenplan.php')).to.have.length(4);
	});

	it('allows only the verified child timetable detail query', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl);

		const result = await session.get('/stundenplan.php?e=1&a=detail_klasse&k=07C&p=123');

		expect(result.classification).to.equal('success');
		expect(server.requests.at(-1)?.url.searchParams.toString()).to.equal('e=1&a=detail_klasse&k=07C&p=123');
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
			'/dateispeicher.php?a=download&f=123',
			'/upload.php',
			'/ajax.php?f=rsaHandshake',
			'/kalender.php?a=export&export=csv',
			'/kalender.php?a=export&year=2026',
			'/dateispeicher.php?A=download',
			'/stundenplan.php?k=all',
			'/stundenplan.php?K=all',
			'/stundenplan.php?a=detail_klasse&k=07C&p=123',
			'/stundenplan.php?e=1&a=detail_klasse&k=07C&p=invalid',
			'/stundenplan.php?e=1&a=detail_klasse&k=07C&p=123&token=private',
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

	it('rejects invalid read-form dates and oversized calendar ranges before authentication', async () => {
		const server = createFakePortal();
		const session = makeSession(server.fetchImpl);
		for (const request of [
			{ type: 'calendar-events' as const, start: '2026-02-30', end: '2026-03-01' },
			{ type: 'calendar-events' as const, start: '2026-01-01', end: '2028-01-01' },
			{ type: 'substitution-day' as const, date: '31.02.2026', portalTag: '31_02_2026' },
			{ type: 'substitution-day' as const, date: '06.05.2026', portalTag: '07_05_2026' },
		]) {
			let error: unknown;
			try {
				await session.postRead(request);
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
		expect((error as PortalSessionError).diagnosticCode).to.equal('rsa-handshake-invalid');
		expect(server.requests.some(request => request.url.pathname === '/stundenplan.php')).to.equal(false);
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

	it('aborts in-flight reads on close and rejects further requests', async () => {
		const server = createFakePortal();
		let aborted = false;
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
			if (url.pathname === '/stundenplan.php') {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => {
							aborted = true;
							reject(new Error('aborted'));
						},
						{ once: true },
					);
				});
			}
			return server.fetchImpl(input, init);
		};
		const session = makeSession(fetchImpl);
		await session.authenticate();
		const pending = session.get('/stundenplan.php');
		await new Promise(resolve => setTimeout(resolve, 0));
		session.close();

		let error: unknown;
		try {
			await pending;
		} catch (caught) {
			error = caught;
		}
		expect(aborted).to.equal(true);
		expect(error).to.be.instanceOf(PortalSessionError);
		expect((error as PortalSessionError).code).to.equal('closed');
		let closedError: unknown;
		try {
			await session.get('/stundenplan.php');
		} catch (caught) {
			closedError = caught;
		}
		expect((closedError as PortalSessionError).code).to.equal('closed');
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

	it('does not read declared-oversize responses and reports only bounded size metadata', async () => {
		let bodyPullCount = 0;
		const unreadBody = new ReadableStream<Uint8Array>(
			{
				pull: () => {
					bodyPullCount++;
				},
			},
			{ highWaterMark: 0 },
		);
		const server = createFakePortal({
			onRead: () =>
				new Response(unreadBody, {
					status: 200,
					headers: { 'content-length': '32', 'content-type': 'text/html' },
				}),
		});
		const result = await makeSession(server.fetchImpl, { maxResponseBytes: 8 }).get('/stundenplan.php');
		expect(result.classification).to.equal('response-too-large');
		expect(result.status).to.equal(200);
		expect(result.contentType).to.equal('text/html');
		expect(result.body).to.have.length(0);
		expect(bodyPullCount).to.equal(0);
		expect(result.responseSizeDiagnostic).to.deep.equal({
			limitBytes: 8,
			declaredContentLength: 32,
			streamingExceededLimit: false,
			prefixClassification: 'not-inspected',
		});
		expect(classifyPortalStatus(403)).to.equal('forbidden');
		expect(classifyPortalStatus(404)).to.equal('not-found');
		expect(classifyPortalStatus(429)).to.equal('rate-limited');
		expect(classifyPortalStatus(503)).to.equal('server-error');
	});

	it('reports a streaming limit exceedance without recording response bytes', async () => {
		const server = createFakePortal({
			onRead: () => new Response('x'.repeat(32), { status: 200, headers: { 'content-type': 'text/html' } }),
		});
		const result = await makeSession(server.fetchImpl, { maxResponseBytes: 8 }).get('/stundenplan.php');
		expect(result.classification).to.equal('response-too-large');
		expect(result.responseSizeDiagnostic).to.deep.equal({
			limitBytes: 8,
			streamingExceededLimit: true,
			prefixClassification: 'plain-text',
		});
		expect(result).not.to.have.property('bodyByteLength');
	});

	it('classifies bounded prefixes from oversized streaming responses without retaining content', async () => {
		const cases = [
			{ body: '{"kind":"list","rows":"private message text"}', expected: 'json-object-with-rows' },
			{ body: '{"error":"private response text"}', expected: 'json-object' },
			{ body: '[{"subject":"private message text"}]', expected: 'json-array' },
			{ body: '<!doctype html><html><body>private text</body></html>', expected: 'html' },
			{ body: 'Private portal response text', expected: 'plain-text' },
			{ body: `${' '.repeat(512)}{"rows":"private message text"}`, expected: 'unknown' },
		] as const;

		for (const testCase of cases) {
			const server = createFakePortal({
				onRead: () => new Response(testCase.body, { status: 200, headers: { 'content-type': 'text/plain' } }),
			});
			const result = await makeSession(server.fetchImpl, { maxResponseBytes: 8 }).get('/stundenplan.php');
			expect(result.classification).to.equal('response-too-large');
			expect(result.body).to.have.length(0);
			expect(result.responseSizeDiagnostic?.prefixClassification).to.equal(testCase.expected);
			expect(JSON.stringify(result.responseSizeDiagnostic)).not.to.contain('private');
		}
	});

	it('records the raw byte length of a bounded successful response', async () => {
		const body = '<html><body><table></table></body></html>';
		const server = createFakePortal({
			onRead: () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
		});
		const result = await makeSession(server.fetchImpl).get('/stundenplan.php');
		expect(result.classification).to.equal('success');
		expect(result.bodyByteLength).to.equal(Buffer.byteLength(body));
	});
});
