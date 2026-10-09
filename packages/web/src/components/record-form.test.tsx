/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import type {Field} from '@proxy/integrations';
import {RecordForm} from '@/components/record-form';

const fields: Field[] = [{key: 'title', label: 'Title', type: 'text'}];

afterEach(() => {
	cleanup();
});

describe('RecordForm', () => {
	test('keeps a required-non-empty submission disabled until a field has a value', () => {
		const onSubmit = mock();
		render(<RecordForm fields={fields} submitLabel="Save" requireNonEmpty onSubmit={onSubmit} />);

		const save = screen.getByRole('button', {name: 'Save'});
		const title = screen.getByRole('textbox', {name: 'Title'});
		expect(save.hasAttribute('disabled')).toBe(true);
		const form = title.closest('form');
		if (!form) {
			throw new Error('RecordForm did not render a form');
		}
		fireEvent.submit(form);
		expect(onSubmit).not.toHaveBeenCalled();

		fireEvent.change(title, {target: {value: '   '}});
		expect(save.hasAttribute('disabled')).toBe(true);

		fireEvent.change(title, {target: {value: 'Home'}});
		expect(save.hasAttribute('disabled')).toBe(false);
		fireEvent.click(save);
		expect(onSubmit).toHaveBeenCalledWith({title: 'Home'});
	});

	test('keeps empty submission available unless the caller requires a value', () => {
		render(<RecordForm fields={fields} submitLabel="Send" onSubmit={() => undefined} />);

		expect(screen.getByRole('button', {name: 'Send'}).hasAttribute('disabled')).toBe(false);
	});
});
