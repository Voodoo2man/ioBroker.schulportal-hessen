import type { PortalResponse } from './portal-session';

function getSafeContentType(contentType: string | null): string {
	const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
	if (!mediaType) {
		return 'missing';
	}
	if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
		return 'text/html';
	}
	if (mediaType === 'application/json' || mediaType === 'text/json' || mediaType.endsWith('+json')) {
		return 'application/json';
	}
	if (mediaType === 'text/csv' || mediaType === 'application/csv') {
		return 'text/csv';
	}
	if (
		mediaType === 'text/calendar' ||
		mediaType === 'application/calendar' ||
		mediaType === 'text/icalendar' ||
		mediaType === 'text/x-vcalendar' ||
		mediaType === 'application/ics'
	) {
		return 'text/calendar';
	}
	if (mediaType === 'text/plain') {
		return 'text/plain';
	}
	return 'other';
}

/**
 * Format only bounded size and HTTP metadata for an oversized response.
 *
 * @param response Oversized response with safe size metadata.
 */
export function formatOversizedResponseDiagnostic(response: PortalResponse): string {
	const size = response.responseSizeDiagnostic;
	return [
		`http=${response.status}`,
		`content-type=${getSafeContentType(response.contentType)}`,
		`limit-bytes=${size?.limitBytes ?? 'unknown'}`,
		`declared-content-length=${size?.declaredContentLength ?? 'unavailable'}`,
		`streaming-exceeded-limit=${size?.streamingExceededLimit === true}`,
		`prefix-classification=${size?.prefixClassification ?? 'not-inspected'}`,
	].join('; ');
}

/**
 * Format fixed timetable parser metadata without including response content.
 *
 * @param response Parsed timetable response and safe transport metadata.
 */
export function formatInvalidTimetableDiagnostic(response: PortalResponse): string {
	return [
		'reason=timetable-sections-missing-with-tables',
		`http=${response.status}`,
		`content-type=${getSafeContentType(response.contentType)}`,
		`body-bytes=${response.bodyByteLength ?? response.body.byteLength}`,
	].join('; ');
}
