import dns from 'node:dns/promises';
import {BlockList, isIP} from 'node:net';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {env} from './env';

// The addresses that are never on the public internet: loopback, the private networks, link-local
// (the cloud metadata address among them), carrier-grade NAT, and the unspecified, benchmark,
// multicast and reserved ranges, with their IPv6 counterparts. An IPv4 address written as IPv6
// (`::ffff:10.0.0.1`) is checked against the IPv4 rules.
const PRIVATE = new BlockList();
const PRIVATE_V4: [string, number][] = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	// Multicast, then everything reserved up to broadcast.
	['224.0.0.0', 3],
];
const PRIVATE_V6: [string, number][] = [
	['::', 128],
	['::1', 128],
	['100::', 64],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
];
for (const [address, prefix] of PRIVATE_V4) {
	PRIVATE.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of PRIVATE_V6) {
	PRIVATE.addSubnet(address, prefix, 'ipv6');
}

/** Whether an address is one the public internet never routes to. Anything that isn't an address counts. */
export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) {
		return true;
	}
	return PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function lookup(host: string): Promise<Result<string[], ApiError>> {
	if (isIP(host) !== 0) {
		return Ok([host]);
	}
	const found = await Result.wrapAsync(() => dns.lookup(host, {all: true}));
	if (found.isErr()) {
		return Err(ApiErr.validationError(`${host} couldn’t be found`));
	}
	return Ok(found.value.map((entry) => entry.address));
}

/**
 * The address a typed-in host is connected to: what it resolves to, as long as nothing it resolves
 * to is private, so a connection can't be pointed at something on the server's own network.
 * `ALLOW_PRIVATE_HOSTS` lifts that, for someone self-hosting beside their database. Connecting to
 * the address rather than the name keeps a name that changes what it resolves to from leading
 * somewhere else between the check and the connection.
 */
export async function resolveHost(host: string): Promise<Result<string, ApiError>> {
	const addresses = await lookup(host);
	if (addresses.isErr()) {
		return addresses;
	}
	const [first] = addresses.value;
	if (first === undefined) {
		return Err(ApiErr.validationError(`${host} couldn’t be found`));
	}
	const blocked = env.ALLOW_PRIVATE_HOSTS ? undefined : addresses.value.find(isPrivateAddress);
	if (blocked !== undefined) {
		const which = blocked === host ? 'is' : `resolves to ${blocked},`;
		return Err(ApiErr.validationError(`${host} ${which} a private address, which Personal Agent Proxy doesn’t connect to. Self-hosting beside it, set ALLOW_PRIVATE_HOSTS=true`));
	}
	return Ok(first);
}
