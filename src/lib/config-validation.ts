const CREDENTIALS_PREFIX = 'system.credentials.';
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;
export const MIN_REFRESH_INTERVAL_MINUTES = 5;
export const MAX_REFRESH_INTERVAL_MINUTES = 1440;

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
const ALLOWED_ACCOUNT_FIELDS = new Set(['id', 'displayName', 'schoolId', 'enabled', 'credentialId']);

/**
 * Validates the settings used by the adapter before startup.
 *
 * @param config Partial configuration to support instances without the newer settings yet
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

	const accounts = config.accounts === undefined ? [] : config.accounts;
	if (!Array.isArray(accounts)) {
		return [...errors, 'accounts must be an array'];
	}

	const accountIds = new Set<string>();
	for (const [index, account] of accounts.entries()) {
		const prefix = `accounts[${index}]`;
		if (typeof account !== 'object' || account === null || Array.isArray(account)) {
			errors.push(`${prefix} must be an object`);
			continue;
		}

		for (const field of Object.keys(account)) {
			if (!ALLOWED_ACCOUNT_FIELDS.has(field)) {
				errors.push(`${prefix}.${field} is not a supported account setting`);
				if (PLAINTEXT_CREDENTIAL_FIELDS.has(field.toLowerCase())) {
					errors.push(`${prefix} must reference central credentials instead of storing login or password fields`);
				}
			}
		}

		if (typeof account.id !== 'string' || !ACCOUNT_ID_PATTERN.test(account.id)) {
			errors.push(`${prefix}.id must be an opaque UUID`);
		} else if (accountIds.has(account.id.toLowerCase())) {
			errors.push(`${prefix}.id must be unique`);
		} else {
			accountIds.add(account.id.toLowerCase());
		}

		if (typeof account.enabled !== 'boolean') {
			errors.push(`${prefix}.enabled must be a boolean`);
		}

		if (account.enabled !== true) {
			continue;
		}

		if (typeof account.displayName !== 'string' || account.displayName.trim().length === 0) {
			errors.push(`${prefix}.displayName is required for enabled accounts`);
		}
		if (typeof account.schoolId !== 'string' || account.schoolId.trim().length === 0) {
			errors.push(`${prefix}.schoolId is required for enabled accounts`);
		}
		if (typeof account.credentialId !== 'string' || !account.credentialId.startsWith(CREDENTIALS_PREFIX)) {
			errors.push(`${prefix}.credentialId must reference a central ioBroker credential`);
		}
	}

	return errors;
}
