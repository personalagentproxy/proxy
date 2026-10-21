import {describe, expect, mock, test} from 'bun:test';

mock.module('../utils/env', () => ({env: {ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')}}));

const {entryFrom} = await import('./vault-entries');

describe('entryFrom', () => {
	test('writes an address out a line at a time, under its label', () => {
		const address = {label: 'Home', name: 'Alex Doe', street: '1 Main St', postalCode: '10115', city: 'Berlin', country: 'Germany'};
		expect(entryFrom('addresses', address)).toEqual({key: 'Home', type: 'Address', value: 'Alex Doe\n1 Main St\n10115 Berlin\nGermany'});
	});

	test('leaves out the lines an address has nothing on', () => {
		const address = {label: '', name: '', street: '1 Main St', postalCode: '', city: 'Berlin', country: ''};
		expect(entryFrom('addresses', address)).toEqual({key: 'Address', type: 'Address', value: '1 Main St\nBerlin'});
	});

	test('keeps a note as text, under its title', () => {
		expect(entryFrom('notes', {title: 'Sizes', body: 'Shoes: EU 43'})).toEqual({key: 'Sizes', type: 'Text', value: 'Shoes: EU 43'});
	});

	test('keeps no payment card', () => {
		expect(entryFrom('cards', {label: 'Visa', cardholder: 'A', number: '4242', expiry: '08/28'})).toBeNull();
	});
});
