import { createHash } from 'node:crypto';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Return a renamed generated label only while the current label still matches the adapter's previous label.
 *
 * @param currentName Current object name, possibly customized by a user.
 * @param previousGeneratedName The last adapter-generated name stored in the object's native metadata.
 * @param nextGeneratedName New name derived from the source.
 */
export function getGeneratedObjectNameUpdate(
	currentName: unknown,
	previousGeneratedName: unknown,
	nextGeneratedName: string,
): string | null {
	if (
		typeof currentName !== 'string' ||
		typeof previousGeneratedName !== 'string' ||
		currentName !== previousGeneratedName ||
		previousGeneratedName === nextGeneratedName
	) {
		return null;
	}
	return nextGeneratedName;
}

/**
 * Hash an upstream parser ID into a safe, opaque ioBroker object ID segment.
 *
 * @param sourceId Parser-provided record ID.
 */
export function toSafeDynamicRecordId(sourceId: string): string {
	if (typeof sourceId !== 'string' || sourceId.length === 0 || sourceId.length > 4096) {
		throw new RangeError('Invalid dynamic record source ID');
	}
	return createHash('sha256').update(sourceId).digest('hex');
}

/** Dynamic records to retain and the previously tracked records that may be deleted. */
export interface DynamicRecordSyncPlan {
	/** Sorted IDs present in the confirmed complete result. */
	currentIds: string[];
	/** Previously tracked IDs absent from the confirmed complete result. */
	staleIds: string[];
}

/**
 * Plan safe dynamic-record synchronization without deleting data from an incomplete response.
 *
 * @param previousIds Previously persisted record IDs for this resource.
 * @param currentIds Record IDs from the new response.
 * @param complete Whether parsing confirmed a complete response.
 */
export function planDynamicRecordSync(
	previousIds: readonly string[],
	currentIds: readonly string[],
	complete: boolean,
): DynamicRecordSyncPlan | null {
	if (!complete) {
		return null;
	}
	const uniqueCurrentIds = new Set<string>();
	for (const id of currentIds) {
		if (!RECORD_ID_PATTERN.test(id) || uniqueCurrentIds.has(id)) {
			throw new RangeError('Invalid or duplicate dynamic record ID');
		}
		uniqueCurrentIds.add(id);
	}
	return {
		currentIds: [...uniqueCurrentIds].sort(),
		staleIds: [...new Set(previousIds)].filter(id => RECORD_ID_PATTERN.test(id) && !uniqueCurrentIds.has(id)),
	};
}
