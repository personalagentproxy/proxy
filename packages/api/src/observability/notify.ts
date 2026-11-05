import {createNotifier, formatSlackError, type Notifier} from '@proxy/observability';

import {envLabel, slackConfig} from './config';
import {log} from './log';

/** The team's Slack: sign-ups and alerts (config.ts). Without a token, nothing is posted. */
export const notify: Notifier = createNotifier(
	{...slackConfig, env: envLabel},
	{
		onError: (error, input) => {
			log.warn('slack notify failed', {
				channel: input.channel,
				title: input.title,
				error: formatSlackError(error),
			});
		},
	},
);
