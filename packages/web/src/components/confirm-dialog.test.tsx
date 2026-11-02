/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {ConfirmDialog} from '@/components/confirm-dialog';

afterEach(() => {
	cleanup();
});

function renderDialog({destructive = false}: {destructive?: boolean} = {}) {
	const onClose = mock();
	const onConfirm = mock();
	render(
		<ConfirmDialog
			open
			title="Share this connection?"
			description="Everyone in the organization will be able to use it."
			confirmLabel={destructive ? 'Delete' : 'Share'}
			destructive={destructive}
			onClose={onClose}
			onConfirm={onConfirm}
		/>,
	);
	return {onClose, onConfirm};
}

describe('ConfirmDialog', () => {
	test('uses the confirmation as the default action when it is safe', async () => {
		const {onClose, onConfirm} = renderDialog();
		const confirm = screen.getByRole('button', {name: 'Share'});

		await waitFor(() => expect(document.activeElement).toBe(confirm));
		expect(confirm.getAttribute('type')).toBe('submit');
		fireEvent.click(confirm);

		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	test('uses cancel as the default action when confirmation is destructive', async () => {
		const {onClose, onConfirm} = renderDialog({destructive: true});
		const cancel = screen.getByRole('button', {name: 'Cancel'});

		await waitFor(() => expect(document.activeElement).toBe(cancel));
		expect(cancel.getAttribute('type')).toBe('button');
		fireEvent.click(cancel);

		expect(onConfirm).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
