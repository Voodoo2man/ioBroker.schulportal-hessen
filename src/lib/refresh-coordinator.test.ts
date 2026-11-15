import { expect } from 'chai';
import { RefreshCoordinator } from './refresh-coordinator';

describe('RefreshCoordinator', () => {
	it('shares an active refresh instead of starting overlapping work', async () => {
		const coordinator = new RefreshCoordinator();
		let finish: (() => void) | undefined;
		let active = 0;
		let maximumActive = 0;
		let calls = 0;
		const operation = async (): Promise<void> => {
			calls++;
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise<void>(resolve => {
				finish = resolve;
			});
			active--;
		};

		const first = coordinator.run(operation);
		const second = coordinator.run(operation);
		expect(second).to.equal(first);
		await Promise.resolve();
		expect(calls).to.equal(1);
		finish?.();
		await Promise.all([first, second]);
		expect(maximumActive).to.equal(1);

		await coordinator.run(() => {
			calls++;
			return Promise.resolve();
		});
		expect(calls).to.equal(2);
	});
});
