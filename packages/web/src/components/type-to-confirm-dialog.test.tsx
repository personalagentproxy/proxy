/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {TypeToConfirmDialog} from '@/components/type-to-confirm-dialog';

afterEach(() => {
	cleanup();
});

function renderDialog(onConfirm: () => Promise<string | null>) {
	render(
		<TypeToConfirmDialog
			open
			title="Delete your account?"
			description="This cannot be undone."
			word="alex@example.com"
			confirmLabel="Delete account"
			onClose={mock()}
			onConfirm={onConfirm}
		/>,
	);
	return {
		field: screen.getByLabelText('Type alex@example.com to confirm'),
		button: screen.getByRole('button', {name: 'Delete account'}),
	};
}

describe('TypeToConfirmDialog', () => {
	test('confirms only once the word is typed, in any case', async () => {
		const onConfirm = mock(async () => null);
		const {field, button} = renderDialog(onConfirm);

		expect(button.hasAttribute('disabled')).toBe(true);
		fireEvent.change(field, {target: {value: 'alex@example'}});
		expect(button.hasAttribute('disabled')).toBe(true);
		fireEvent.change(field, {target: {value: ' Alex@Example.com '}});
		fireEvent.click(button);

		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
	});

	test('says what went wrong when it fails', async () => {
		const {field, button} = renderDialog(async () => 'Something went wrong. Try again.');

		fireEvent.change(field, {target: {value: 'alex@example.com'}});
		fireEvent.click(button);

		expect(await screen.findByText('Something went wrong. Try again.')).toBeDefined();
	});
});
