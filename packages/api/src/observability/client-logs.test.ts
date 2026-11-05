import {afterEach, describe, expect, it, mock} from 'bun:test';

type Line = {service: string; level: string; msg: string; ctx: Record<string, unknown> | undefined};
const lines: Line[] = [];

mock.module('@proxy/observability/server', () => ({
	createServerLogger: ({service}: {service: string}) => {
		const write = (level: string) => (msg: string, ctx?: Record<string, unknown>) => void lines.push({service, level, msg, ctx});
		return {debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error')};
	},
}));

const {handleClientLogsRoute} = await import('./client-logs');

function request(body: unknown, userAgent = 'Mozilla/5.0') {
	return {
		body,
		get: (name: string) => (name === 'user-agent' ? userAgent : undefined),
		user: {userId: 'u1'},
	} as unknown as Parameters<typeof handleClientLogsRoute>[0];
}

afterEach(() => {
	lines.length = 0;
});

describe('handleClientLogsRoute', () => {
	it('writes each line on as the web app’s, with its own time and the user agent', async () => {
		const ts = Date.now() - 1_000;
		const result = await handleClientLogsRoute(request({entries: [{ts, level: 'error', msg: 'broke', ctx: {page: 'home'}}]}));
		expect(result.isOk()).toBe(true);
		expect(lines).toEqual([{service: 'web', level: 'error', msg: 'broke', ctx: {page: 'home', clientTs: ts, userAgent: 'Mozilla/5.0'}}]);
	});

	it('writes the desktop app’s lines as its own', async () => {
		await handleClientLogsRoute(request({entries: [{ts: Date.now(), level: 'warn', msg: 'x'}]}, 'Electron PersonalAgentProxyDesktop/1.0'));
		expect(lines[0]).toMatchObject({service: 'desktop', level: 'warn', msg: 'x'});
	});

	it('takes the server’s time over a clock that is far off', async () => {
		const ts = Date.now() - 30 * 24 * 60 * 60 * 1000;
		await handleClientLogsRoute(request({entries: [{ts, level: 'info', msg: 'x'}]}));
		expect(lines[0]?.ctx?.clientTs).not.toBe(ts);
	});

	it('refuses a batch that is not one', async () => {
		const result = await handleClientLogsRoute(request({entries: []}));
		expect(result.unwrapErr().kind).toBe('parse_error');
		expect(lines).toHaveLength(0);
	});
});
