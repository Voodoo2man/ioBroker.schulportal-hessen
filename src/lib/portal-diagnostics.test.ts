import { expect } from 'chai';
import type { PortalResponse } from './portal-session';
import { formatInvalidTimetableDiagnostic, formatOversizedResponseDiagnostic } from './portal-diagnostics';

describe('Portal response diagnostics', () => {
	it('formats only bounded metadata for oversized responses', () => {
		const response: PortalResponse = {
			status: 200,
			classification: 'response-too-large',
			contentType: 'text/html; charset=utf-8; private=value',
			body: new TextEncoder().encode('private response body'),
			responseSizeDiagnostic: {
				limitBytes: 8,
				declaredContentLength: 32,
				streamingExceededLimit: false,
				prefixClassification: 'not-inspected',
			},
		};

		const diagnostic = formatOversizedResponseDiagnostic(response);
		expect(diagnostic).to.equal(
			'http=200; content-type=text/html; limit-bytes=8; declared-content-length=32; streaming-exceeded-limit=false; prefix-classification=not-inspected',
		);
		expect(diagnostic).not.to.contain('private');
	});

	it('indicates a streaming limit without exposing body or raw content type', () => {
		const response: PortalResponse = {
			status: 200,
			classification: 'response-too-large',
			contentType: 'application/x-private; token=secret',
			body: new Uint8Array(),
			responseSizeDiagnostic: {
				limitBytes: 4 * 1024 * 1024,
				streamingExceededLimit: true,
				prefixClassification: 'json-object-with-rows',
			},
		};

		const diagnostic = formatOversizedResponseDiagnostic(response);
		expect(diagnostic).to.equal(
			'http=200; content-type=other; limit-bytes=4194304; declared-content-length=unavailable; streaming-exceeded-limit=true; prefix-classification=json-object-with-rows',
		);
		expect(diagnostic).not.to.contain('secret');
	});

	it('formats invalid timetable metadata with the fixed parser reason and response byte length', () => {
		const response: PortalResponse = {
			status: 200,
			classification: 'success',
			contentType: 'text/html; charset=utf-8; private=value',
			body: new TextEncoder().encode('<table>private</table>'),
			bodyByteLength: 22,
		};

		const diagnostic = formatInvalidTimetableDiagnostic(response);
		expect(diagnostic).to.equal(
			'reason=timetable-sections-missing-with-tables; http=200; content-type=text/html; body-bytes=22',
		);
		expect(diagnostic).not.to.contain('private');
	});
});
