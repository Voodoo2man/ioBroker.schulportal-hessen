/** Coalesces concurrent triggers into one running refresh. */
export class RefreshCoordinator {
	private active: Promise<void> | null = null;

	/**
	 * Run the operation once and share its promise with concurrent callers.
	 *
	 * @param operation Work to run after the current operation settles.
	 */
	run(operation: () => Promise<void>): Promise<void> {
		if (this.active) {
			return this.active;
		}

		const running = Promise.resolve().then(operation);
		this.active = running;
		void running
			.finally(() => {
				if (this.active === running) {
					this.active = null;
				}
			})
			.catch(() => undefined);
		return running;
	}
}
