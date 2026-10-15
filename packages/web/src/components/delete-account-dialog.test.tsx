/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {DeleteAccountDialog} from '@/components/delete-account-dialog';

afterEach(() => {
	cleanup();
});

function renderDialog(onDelete: () => Promise<string | null>) {
	render(
		<DeleteAccountDialog open email="alex@example.com" onClose={mock()} onDelete={onDelete} />,
	);
	return {
		field: screen.getByLabelText('Type alex@example.com to confirm'),
		button: screen.getByRole('button', {name: 'Delete account'}),
	};
}

describe('DeleteAccountDialog', () => {
	test('deletes only once the account’s address is typed, in any case', async () => {
		const onDelete = mock(async () => null);
		const {field, button} = renderDialog(onDelete);

		expect(button.hasAttribute('disabled')).toBe(true);
		fireEvent.change(field, {target: {value: 'alex@example'}});
		expect(button.hasAttribute('disabled')).toBe(true);
		fireEvent.change(field, {target: {value: ' Alex@Example.com '}});
		fireEvent.click(button);

		await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
	});

	test('says what went wrong when the deletion fails', async () => {
		const {field, button} = renderDialog(async () => 'Something went wrong. Try again.');

		fireEvent.change(field, {target: {value: 'alex@example.com'}});
		fireEvent.click(button);

		expect(await screen.findByText('Something went wrong. Try again.')).toBeDefined();
	});
});
