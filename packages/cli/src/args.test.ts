import {describe, expect, test} from 'bun:test';

import {parseInvocation} from './args';

describe('parseInvocation', () => {
	test('reads each command with its words and options', () => {
		expect(
			parseInvocation([
				'login',
				'--url',
				'https://proxy.example.com',
				'--username',
				'claude-x1',
				'--password-stdin',
			]).unwrap(),
		).toEqual({
			command: {
				name: 'login',
				url: 'https://proxy.example.com',
				username: 'claude-x1',
				passwordStdin: true,
			},
			json: false,
		});
		expect(parseInvocation(['connections', '--json']).unwrap()).toEqual({
			command: {name: 'connections'},
			json: true,
		});
		expect(parseInvocation(['tools', 'conn-1']).unwrap().command).toEqual({
			name: 'tools',
			connectionId: 'conn-1',
		});
		expect(
			parseInvocation([
				'run',
				'conn-1',
				'tasks_list',
				'--params',
				'{"parent":"project:inbox","page":"50"}',
			]).unwrap().command,
		).toEqual({
			name: 'run',
			connectionId: 'conn-1',
			tool: 'tasks_list',
			params: {parent: 'project:inbox', page: '50'},
		});
		expect(parseInvocation(['run', 'conn-1', 'tasks_list']).unwrap().command).toMatchObject({
			params: {},
		});
	});

	test('no command, help, or --help is the help', () => {
		for (const argv of [[], ['help'], ['--help'], ['tools', '-h']]) {
			expect(parseInvocation(argv).unwrap().command, argv.join(' ')).toEqual({name: 'help'});
		}
	});

	test('a command used wrongly exits 2 with what is wrong', () => {
		const cases: [string[], string][] = [
			[['frobnicate'], 'proxy has no command frobnicate'],
			[['login', '--url', 'https://proxy.example.com'], 'needs --url and --username'],
			[['tools'], 'needs a connection id'],
			[['run', 'conn-1'], 'needs a connection id and a tool'],
			[['run', 'conn-1', 'tasks_list', '--params', 'parent=x'], '--params must be JSON'],
			[['run', 'conn-1', 'tasks_list', '--params', '["x"]'], 'a JSON object'],
			[['tools', 'conn-1', '--params', '{}'], 'proxy tools takes no --params'],
			[['connections', 'extra'], 'proxy connections takes no extra'],
			[['connections', '--verbose'], 'Unknown option'],
		];
		for (const [argv, message] of cases) {
			const error = parseInvocation(argv).unwrapErr();
			expect(error.exitCode, argv.join(' ')).toBe(2);
			expect(error.message, argv.join(' ')).toContain(message);
		}
	});
});
