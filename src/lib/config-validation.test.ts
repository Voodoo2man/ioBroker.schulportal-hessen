import { expect } from 'chai';
import {
	DEFAULT_REFRESH_INTERVAL_MINUTES,
	MAX_REFRESH_INTERVAL_MINUTES,
	MIN_REFRESH_INTERVAL_MINUTES,
	hasOnlyRecoverableSchoolSearchErrors,
	RECOVERABLE_SCHOOL_ID_ERROR,
	validateAdapterConfig,
} from './config-validation';

describe('validateAdapterConfig', () => {
	it('accepts one account with an optional display name and a central credential reference', () => {
		expect(
			validateAdapterConfig({
				accountName: 'School account',
				schoolId: '01234',
				credentialId: 'system.credentials.school-account',
				refreshIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
			}),
		).to.deep.equal([]);

		expect(
			validateAdapterConfig({ schoolId: '01234', credentialId: 'system.credentials.school-account' }),
		).to.deep.equal([]);
	});

	it('allows a school search term independently of account credentials', () => {
		expect(validateAdapterConfig({ schoolSearch: 'Frankfurt' })).to.deep.equal([]);
		expect(validateAdapterConfig({ schoolSearch: 'x'.repeat(101) })).to.include(
			'schoolSearch must be a string of at most 100 characters',
		);
		expect(validateAdapterConfig({ schoolSearch: 5202 } as unknown as Partial<ioBroker.AdapterConfig>)).to.include(
			'schoolSearch must be a string of at most 100 characters',
		);
	});

	it('allows a wholly unconfigured instance and applies the default interval', () => {
		expect(validateAdapterConfig({})).to.deep.equal([]);
		expect(validateAdapterConfig({ accountName: '', schoolId: '', credentialId: '' })).to.deep.equal([]);
	});

	it('ignores an empty legacy account list and rejects configured legacy account arrays', () => {
		expect(validateAdapterConfig({ accounts: [], refreshIntervalMinutes: 60 })).to.deep.equal([]);
		expect(
			validateAdapterConfig({ accounts: [{ id: 'legacy' }] } as Partial<ioBroker.AdapterConfig>),
		).to.deep.equal([
			'non-empty accounts is no longer supported; configure exactly one Schulportal Hessen account per adapter instance and add another adapter instance for each additional account',
		]);
	});

	it('rejects partially configured account details', () => {
		expect(validateAdapterConfig({ schoolId: '01234' })).to.include(
			'schoolId and credentialId must both be configured for an account',
		);
		expect(validateAdapterConfig({ credentialId: 'system.credentials.school-account' })).to.include(
			'schoolId and credentialId must both be configured for an account',
		);
		expect(validateAdapterConfig({ accountName: 'School account' })).to.include(
			'accountName may only be set when both schoolId and credentialId are configured',
		);
	});

	it('rejects malformed school IDs and central credential references', () => {
		const errors = validateAdapterConfig({
			schoolId: 'school-1',
			credentialId: 'system.credentials.',
		});

		expect(errors)
			.to.include(RECOVERABLE_SCHOOL_ID_ERROR)
			.and.to.include('credentialId must reference a valid central ioBroker credential');
		expect(hasOnlyRecoverableSchoolSearchErrors(errors)).to.equal(false);
		expect(
			validateAdapterConfig({
				schoolId: '01234',
				credentialId: 'system.credentials..school-account',
			}),
		).to.include('credentialId must reference a valid central ioBroker credential');
		expect(
			validateAdapterConfig({ schoolId: ' 01234 ', credentialId: 'system.credentials.school-account' }),
		).to.include('schoolId must be a numeric Schulportal school ID of 1 to 20 digits');
	});

	it('keeps school-search-only config errors recoverable, and rejects unrelated errors', () => {
		const schoolIdErrors = validateAdapterConfig({
			schoolId: 'school-1',
			credentialId: 'system.credentials.school-account',
		});
		expect(schoolIdErrors).to.deep.equal([RECOVERABLE_SCHOOL_ID_ERROR]);
		expect(hasOnlyRecoverableSchoolSearchErrors(schoolIdErrors)).to.equal(true);

		const missingSchoolErrors = validateAdapterConfig({
			schoolId: '',
			credentialId: 'system.credentials.school-account',
		});
		expect(missingSchoolErrors).to.deep.equal(['schoolId and credentialId must both be configured for an account']);
		expect(hasOnlyRecoverableSchoolSearchErrors(missingSchoolErrors)).to.equal(true);

		const optionalNameErrors = validateAdapterConfig({ accountName: 'School account' });
		expect(optionalNameErrors).to.deep.equal([
			'accountName may only be set when both schoolId and credentialId are configured',
		]);
		expect(hasOnlyRecoverableSchoolSearchErrors(optionalNameErrors)).to.equal(true);

		const namedUnconfiguredErrors = validateAdapterConfig({
			accountName: 'School account',
			schoolId: '',
			credentialId: 'system.credentials.school-account',
		});
		expect(hasOnlyRecoverableSchoolSearchErrors(namedUnconfiguredErrors)).to.equal(true);

		const invalidCredentialErrors = validateAdapterConfig({ schoolId: '', credentialId: 'system.credentials.' });
		expect(hasOnlyRecoverableSchoolSearchErrors(invalidCredentialErrors)).to.equal(false);

		const unknownFieldErrors = validateAdapterConfig({
			schoolId: '',
			credentialId: 'system.credentials.school-account',
			unknownSetting: true,
		} as Partial<ioBroker.AdapterConfig>);
		expect(hasOnlyRecoverableSchoolSearchErrors(unknownFieldErrors)).to.equal(false);

		const malformedTypeErrors = validateAdapterConfig({
			schoolId: 123,
			credentialId: 'system.credentials.school-account',
		} as unknown as Partial<ioBroker.AdapterConfig>);
		expect(hasOnlyRecoverableSchoolSearchErrors(malformedTypeErrors)).to.equal(false);

		const invalidIntervalErrors = validateAdapterConfig({
			schoolId: '',
			credentialId: 'system.credentials.school-account',
			refreshIntervalMinutes: 4,
		});
		expect(hasOnlyRecoverableSchoolSearchErrors(invalidIntervalErrors)).to.equal(false);
		expect(hasOnlyRecoverableSchoolSearchErrors([])).to.equal(false);
	});

	it('rejects plaintext credential fields without exposing their values', () => {
		const errors = validateAdapterConfig({
			schoolId: '01234',
			credentialId: 'system.credentials.school-account',
			password: 'must-not-be-stored',
		} as Partial<ioBroker.AdapterConfig>);

		expect(errors).to.include(
			'password must not be stored in adapter configuration; use a central credential reference',
		);
		expect(errors.join(' ')).not.to.include('must-not-be-stored');
	});

	it('rejects unsupported nested credential settings without exposing their values', () => {
		const errors = validateAdapterConfig({
			schoolId: '01234',
			credentialId: 'system.credentials.school-account',
			credentials: { login: 'student', password: 'must-not-be-stored' },
		} as Partial<ioBroker.AdapterConfig>);

		expect(errors).to.include('credentials is not a supported adapter setting');
		expect(errors.join(' ')).not.to.include('must-not-be-stored');
	});

	it('rejects invalid, fractional and over-limit refresh intervals', () => {
		const intervalError = `refreshIntervalMinutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}`;
		expect(validateAdapterConfig({ refreshIntervalMinutes: MIN_REFRESH_INTERVAL_MINUTES - 1 })).to.include(
			intervalError,
		);
		expect(validateAdapterConfig({ refreshIntervalMinutes: 1.5 })).to.include(intervalError);
		expect(validateAdapterConfig({ refreshIntervalMinutes: MAX_REFRESH_INTERVAL_MINUTES + 1 })).to.include(
			intervalError,
		);
	});
});
