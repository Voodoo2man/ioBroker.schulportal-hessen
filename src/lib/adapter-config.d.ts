// This file extends the AdapterConfig type from "@iobroker/types"

declare global {
	namespace ioBroker {
		interface SchulportalHessenAccountConfig {
			id: string;
			displayName: string;
			schoolId: string;
			enabled: boolean;
			credentialId: string;
		}

		interface AdapterConfig {
			accountName?: string;
			schoolSearch?: string;
			schoolId: string;
			credentialId: string;
			refreshIntervalMinutes: number;
			/** @deprecated Legacy configuration is rejected; use one adapter instance per account. */
			accounts?: SchulportalHessenAccountConfig[];
		}
	}
}

// This is required so the above AdapterConfig is found by TypeScript / type checking.
export {};