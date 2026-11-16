import {describe, expect, test} from 'bun:test';
import {rowDraftPreview} from '@/lib/chat-sidebar-preview';

describe('rowDraftPreview', () => {
	test('active chat with draft shows no draft line', () => {
		expect(rowDraftPreview('general', 'general', 'Move the pricing review')).toBe(null);
	});

	test('inactive chat with draft shows preview text', () => {
		expect(rowDraftPreview('general', 'finance', 'Pay the invoice')).toBe('Pay the invoice');
	});
});
