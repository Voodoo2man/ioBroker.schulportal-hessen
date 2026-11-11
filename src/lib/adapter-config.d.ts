// This file extends the AdapterConfig type from "@iobroker/types"

// Augment the globally declared type ioBroker.AdapterConfig
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
			accounts: SchulportalHessenAccountConfig[];
			refreshIntervalMinutes: number;
		}
	}
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};