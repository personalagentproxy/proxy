import dns from 'node:dns/promises';
import {BlockList, isIP} from 'node:net';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

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

// Read when a host is checked rather than when this module loads: the MCP client checks every
// address, and the modules that only parse a server's answers import it without needing the
// environment, as their tests do.
async function allowsPrivateHosts(): Promise<boolean> {
	const {env} = await import('./env');
	return env.ALLOW_PRIVATE_HOSTS;
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
	const blocked = (await allowsPrivateHosts()) ? undefined : addresses.value.find(isPrivateAddress);
	if (blocked !== undefined) {
		const which = blocked === host ? 'is' : `resolves to ${blocked},`;
		return Err(ApiErr.validationError(`${host} ${which} a private address, which Personal Agent Proxy doesn’t connect to. Self-hosting beside it, set ALLOW_PRIVATE_HOSTS=true`));
	}
	return Ok(first);
}

// An IPv6 address in an address is written in brackets, which the lookup doesn't take.
function hostOf(url: URL): string {
	return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/**
 * An address the api may call, typed in or named by a server: its host resolves as `resolveHost`
 * allows, and it is `https`, or `http` only to a private address, where a token isn't sent over
 * the internet in the clear. Checked before every request to such an address, not once when it
 * is typed in, since a name can change what it resolves to.
 */
export function checkUrl(url: URL): Promise<Result<URL, ApiError>> {
	return Do(async ($) => {
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			return $(Err(ApiErr.validationError(`${url.toString()} has to start with https://`)));
		}
		const address = $(await resolveHost(hostOf(url)));
		if (url.protocol === 'http:' && !isPrivateAddress(address)) {
			return $(Err(ApiErr.validationError(`${url.host} has to be reached over https://, unless it is on a private address`)));
		}
		return url;
	});
}

/**
 * Whether a server out on the internet can reach the address: `https`, on a host that resolves only
 * to public addresses, whatever `ALLOW_PRIVATE_HOSTS` says, since that is about what the api calls
 * rather than what calls it.
 */
export async function isPublicHttpsUrl(url: URL): Promise<boolean> {
	if (url.protocol !== 'https:') {
		return false;
	}
	const addresses = await lookup(hostOf(url));
	return addresses.isOk() && addresses.value.length > 0 && !addresses.value.some(isPrivateAddress);
}
