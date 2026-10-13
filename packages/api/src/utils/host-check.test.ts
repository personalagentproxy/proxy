import {beforeEach, describe, expect, mock, test} from 'bun:test';

const lookup = mock();

mock.module('node:dns/promises', () => ({default: {lookup}}));

const env = {ALLOW_PRIVATE_HOSTS: false};

mock.module('./env', () => ({env}));

beforeEach(() => {
	mock.clearAllMocks();
	env.ALLOW_PRIVATE_HOSTS = false;
});

describe('isPrivateAddress', () => {
	test('knows the ranges the public internet never routes to, in both families', async () => {
		const {isPrivateAddress} = await import('./host-check');
		for (const address of [
			'127.0.0.1',
			'10.1.2.3',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.5',
			'169.254.169.254',
			'100.64.0.1',
			'0.0.0.0',
			'224.0.0.1',
			'255.255.255.255',
			'::1',
			'::',
			'fd12::1',
			'fe80::1',
			'::ffff:10.0.0.1',
		]) {
			expect(isPrivateAddress(address), address).toBe(true);
		}
		for (const address of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
			expect(isPrivateAddress(address), address).toBe(false);
		}
	});

	test('counts what is no address at all as private', async () => {
		const {isPrivateAddress} = await import('./host-check');
		expect(isPrivateAddress('localhost')).toBe(true);
	});
});

describe('resolveHost', () => {
	test('answers the address a public host resolves to', async () => {
		const {resolveHost} = await import('./host-check');
		lookup.mockResolvedValue([{address: '203.0.113.5', family: 4}]);
		expect((await resolveHost('db.example.com')).unwrap()).toBe('203.0.113.5');
		expect(lookup).toHaveBeenCalledWith('db.example.com', {all: true});
	});

	test('takes an address as it is, without a lookup', async () => {
		const {resolveHost} = await import('./host-check');
		expect((await resolveHost('203.0.113.5')).unwrap()).toBe('203.0.113.5');
		expect(lookup).not.toHaveBeenCalled();
	});

	test('refuses a host that resolves to a private address, even among public ones', async () => {
		const {resolveHost} = await import('./host-check');
		lookup.mockResolvedValue([
			{address: '203.0.113.5', family: 4},
			{address: '10.0.0.7', family: 4},
		]);
		const error = (await resolveHost('db.example.com')).unwrapErr();
		expect(error).toMatchObject({kind: 'validation_error'});
		expect(error.kind === 'validation_error' && error.message).toContain('10.0.0.7');
		expect((await resolveHost('192.168.1.5')).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});

	test('lets private addresses through when ALLOW_PRIVATE_HOSTS says so', async () => {
		const {resolveHost} = await import('./host-check');
		env.ALLOW_PRIVATE_HOSTS = true;
		lookup.mockResolvedValue([{address: '127.0.0.1', family: 4}]);
		expect((await resolveHost('localhost')).unwrap()).toBe('127.0.0.1');
		expect((await resolveHost('192.168.1.5')).unwrap()).toBe('192.168.1.5');
	});

	test('a host that cannot be found, or resolves to nothing, is a bad request', async () => {
		const {resolveHost} = await import('./host-check');
		lookup.mockRejectedValue(new Error('ENOTFOUND'));
		expect((await resolveHost('nope.example.com')).unwrapErr()).toMatchObject({kind: 'validation_error'});
		lookup.mockResolvedValue([]);
		expect((await resolveHost('empty.example.com')).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});
});
