import { expect } from 'chai';
import {
	DEFAULT_REFRESH_INTERVAL_MINUTES,
	MAX_REFRESH_INTERVAL_MINUTES,
	MIN_REFRESH_INTERVAL_MINUTES,
	validateAdapterConfig,
} from './config-validation';

const validAccount: ioBroker.SchulportalHessenAccountConfig = {
	id: 'bf987cf1-07c4-4648-9157-4b7122a19720',
	displayName: 'School account',
	schoolId: 'school-1',
	enabled: true,
	credentialId: 'system.credentials.school-account',
};

describe('validateAdapterConfig', () => {
	it('accepts enabled accounts with unique IDs and central credential references', () => {
		expect(
			validateAdapterConfig({
				accounts: [validAccount],
				refreshIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
			}),
		).to.deep.equal([]);
	});

	it('allows incomplete disabled accounts and applies the default interval when omitted', () => {
		expect(
			validateAdapterConfig({
				accounts: [
					{
						id: '1d9ed19c-4212-4de9-8a68-0e4bf687ea2f',
						enabled: false,
					} as ioBroker.SchulportalHessenAccountConfig,
				],
			}),
		).to.deep.equal([]);
	});

	it('rejects duplicate IDs and plaintext credential fields without exposing their values', () => {
		const accountWithPassword = { ...validAccount, id: validAccount.id.toUpperCase(), password: 'must-not-be-stored' };
		const errors = validateAdapterConfig({
			accounts: [validAccount, accountWithPassword],
			refreshIntervalMinutes: DEFAULT_REFRESH_INTERVAL_MINUTES,
		});

		expect(errors)
			.to.include('accounts[1].id must be unique')
			.and.to.include(
				'accounts[1] must reference central credentials instead of storing login or password fields',
			);
		expect(errors.join(' ')).not.to.include('must-not-be-stored');
	});

	it('rejects unrecognized nested credential fields', () => {
		const accountWithCredentials = {
			...validAccount,
			credentials: { login: 'student', password: 'must-not-be-stored' },
		};
		const errors = validateAdapterConfig({ accounts: [accountWithCredentials] });

		expect(errors).to.include('accounts[0].credentials is not a supported account setting');
		expect(errors.join(' ')).not.to.include('must-not-be-stored');
	});

	it('rejects invalid enabled credentials and refresh interval bounds', () => {
		const invalidAccount = { ...validAccount, credentialId: 'plaintext' };
		expect(
			validateAdapterConfig({
				accounts: [invalidAccount],
				refreshIntervalMinutes: MIN_REFRESH_INTERVAL_MINUTES - 1,
			}),
		)
			.to.include('accounts[0].credentialId must reference a central ioBroker credential')
			.and.to.include(
				`refreshIntervalMinutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}`,
			);
	});

	it('rejects fractional and over-limit intervals', () => {
		expect(validateAdapterConfig({ refreshIntervalMinutes: 1.5 })).to.include(
			`refreshIntervalMinutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}`,
		);
		expect(validateAdapterConfig({ refreshIntervalMinutes: MAX_REFRESH_INTERVAL_MINUTES + 1 })).to.include(
			`refreshIntervalMinutes must be an integer between ${MIN_REFRESH_INTERVAL_MINUTES} and ${MAX_REFRESH_INTERVAL_MINUTES}`,
		);
	});
});
