import {describe, expect, test} from 'bun:test';
import {
	clampPanelWidth,
	PANEL_MAX_WIDTH,
	PANEL_MIN_WIDTH,
	storedPanelWidth,
} from '@/hooks/use-panel-width';

function storageWith(value: string | null): Pick<Storage, 'getItem'> {
	return {getItem: () => value};
}

describe('clampPanelWidth', () => {
	test('keeps a width between the narrowest and widest, in whole pixels', () => {
		expect(clampPanelWidth(300.6)).toBe(301);
		expect(clampPanelWidth(0)).toBe(PANEL_MIN_WIDTH);
		expect(clampPanelWidth(5000)).toBe(PANEL_MAX_WIDTH);
	});
});

describe('storedPanelWidth', () => {
	test('reads the width kept, within the bounds', () => {
		expect(storedPanelWidth(storageWith('320'))).toBe(320);
		expect(storedPanelWidth(storageWith('9999'))).toBe(PANEL_MAX_WIDTH);
	});

	test('is null with nothing kept, something that is no number, or no storage', () => {
		expect(storedPanelWidth(storageWith(null))).toBeNull();
		expect(storedPanelWidth(storageWith('wide'))).toBeNull();
		expect(storedPanelWidth(null)).toBeNull();
	});

	test('is null where storage refuses to be read', () => {
		const blocked = {
			getItem: () => {
				throw new Error('blocked');
			},
		};
		expect(storedPanelWidth(blocked)).toBeNull();
	});
});
