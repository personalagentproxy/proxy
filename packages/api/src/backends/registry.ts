import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {claudeAgentSdkHarness} from '@proxy/backends/harness/claude-agent-sdk';

import {proxyHarness} from '../harness/proxy-harness';
import {sdkSessionStore} from '../harness/session-store';
import {harnessStore} from '../harness/store';
import {askForTurn} from '../llm/open-router';
import {env} from '../utils/env';
import type {HarnessRegistry} from './harness';

/**
 * The built-in agent's harnesses as this server has them, made once: the loop over OpenRouter,
 * where there is a key for it; the Claude Agent SDK's, for personas set to run on their members'
 * own Claude accounts, unless it is turned off. The worker runs turns on them, and the Chat
 * page's routes list them, with their models, for a persona to choose from. The SDK's
 * subprocesses work and keep their config under the temp directory, each thread in a directory of
 * its own; their transcripts go to the database.
 */

let made: HarnessRegistry | null = null;

function make(): HarnessRegistry {
	const harnessDir = join(tmpdir(), 'proxy-harness');
	return {
		proxy: env.OPENROUTER_KEY ? proxyHarness({askForTurn, key: env.OPENROUTER_KEY}) : null,
		claudeAgentSdk:
			env.CLAUDE_AGENT_SDK === 'off'
				? null
				: claudeAgentSdkHarness({
						sessionStore: sdkSessionStore(harnessStore),
						workDir: join(harnessDir, 'work'),
						configDir: join(harnessDir, 'config'),
						maxConcurrentTurns: env.CLAUDE_AGENT_SDK_TURNS,
					}),
	};
}

export function serverHarnesses(): HarnessRegistry {
	made ??= make();
	return made;
}
