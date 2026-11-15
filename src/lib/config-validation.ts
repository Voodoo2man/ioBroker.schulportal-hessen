const CENTRAL_CREDENTIAL_ID_PATTERN = /^system\.credentials\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const SCHOOL_ID_PATTERN = /^\d{1,20}$/;

export const RECOVERABLE_SCHOOL_ID_ERROR = 'schoolId must be a numeric Schulportal school ID of 1 to 20 digits';
const SCHOOL_CREDENTIAL_PAIR_ERROR = 'schoolId and credentialId must both be configured for an account';
const ACCOUNT_NAME_REQUIREMENT_ERROR = 'accountName may only be set when both schoolId and credentialId are configured';
const RECOVERABLE_SCHOOL_SEARCH_ERRORS = new Set([
	RECOVERABLE_SCHOOL_ID_ERROR,
	SCHOOL_CREDENTIAL_PAIR_ERROR,
	ACCOUNT_NAME_REQUIREMENT_ERROR,
]);

/**
 * Check whether validation failed only because account selection is incomplete.
 *
 * @param errors Adapter configuration validation errors.
 * @returns True when Admin school search can safely recover the configuration.
 */
export function hasOnlyRecoverableSchoolSearchErrors(errors: readonly string[]): boolean {
	return errors.length > 0 && errors.every(error => RECOVERABLE_SCHOOL_SEARCH_ERRORS.has(error));
}

export const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;
export const MIN_REFRESH_INTERVAL_MINUTES = 5;
export const MAX_REFRESH_INTERVAL_MINUTES = 1440;

const ALLOWED_CONFIG_FIELDS = new Set([
	'accountName',
	'schoolSearch',
	'schoolId',
	'credentialId',
	'refreshIntervalMinutes',
	'accounts',
]);
const PLAINTEXT_CREDENTIAL_FIELDS = new Set([
	'login',
	'password',
	'pass',
	'username',
	'user',
	'user2',
	'cookie',
	'sid',
	'token',
	'secret',
]);

/**
 * Validates the settings used by the adapter before startup.
 *
 * @param config Partial configuration to support instances without configured account details
 */
export function validateAdapterConfig(config: Partial<ioBroker.AdapterConfig>): string[] {
	const errors: string[] = [];
	const refreshInterval =
		config.refreshIntervalMinutes === undefined ? DEFAULT_REFRESH_INTERVAL_MINUTES : config.refreshIntervalMinutes;

	if (
		typeof refreshInterval !== 'number' ||
		!Number.isInteger(refreshInterval) ||
		refreshInterval < MIN_REFRESH_INTERVAL_MINUTES ||
		refreshInterval > MAX_REFRESH_INTERVAL_MINUTES
	) {
		errors.push(
			`refreshIntervalMinutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}`,
		);
	}

	if (
		Object.prototype.hasOwnProperty.call(config, 'accounts') &&
		(!Array.isArray(config.accounts) || config.accounts.length > 0)
	) {
		errors.push(
			'non-empty accounts is no longer supported; configure exactly one Schulportal Hessen account per adapter instance and add another adapter instance for each additional account',
		);
		return errors;
	}

	for (const field of Object.keys(config)) {
		if (PLAINTEXT_CREDENTIAL_FIELDS.has(field.toLowerCase())) {
			errors.push(`${field} must not be stored in adapter configuration; use a central credential reference`);
		} else if (!ALLOWED_CONFIG_FIELDS.has(field)) {
			errors.push(`${field} is not a supported adapter setting`);
		}
	}

	if (config.accountName !== undefined && typeof config.accountName !== 'string') {
		errors.push('accountName must be a string');
	}
	if (
		config.schoolSearch !== undefined &&
		(typeof config.schoolSearch !== 'string' || config.schoolSearch.length > 100)
	) {
		errors.push('schoolSearch must be a string of at most 100 characters');
	}
	if (config.schoolId !== undefined && typeof config.schoolId !== 'string') {
		errors.push('schoolId must be a string');
	}
	if (config.credentialId !== undefined && typeof config.credentialId !== 'string') {
		errors.push('credentialId must be a string');
	}

	const accountName = typeof config.accountName === 'string' ? config.accountName.trim() : '';
	const schoolId = typeof config.schoolId === 'string' ? config.schoolId : '';
	const credentialId = typeof config.credentialId === 'string' ? config.credentialId : '';
	const hasSchoolId = schoolId.length > 0;
	const hasCredentialId = credentialId.length > 0;

	if (hasSchoolId !== hasCredentialId) {
		errors.push(SCHOOL_CREDENTIAL_PAIR_ERROR);
	}
	if (accountName && (!hasSchoolId || !hasCredentialId)) {
		errors.push(ACCOUNT_NAME_REQUIREMENT_ERROR);
	}
	if (hasSchoolId && !SCHOOL_ID_PATTERN.test(schoolId)) {
		errors.push(RECOVERABLE_SCHOOL_ID_ERROR);
	}
	if (hasCredentialId && !CENTRAL_CREDENTIAL_ID_PATTERN.test(credentialId)) {
		errors.push('credentialId must reference a valid central ioBroker credential');
	}

	return errors;
}
