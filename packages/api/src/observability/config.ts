import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {config} from 'dotenv';

import type {EnvLabel, LokiConfig, MetricsConfig, SlackConfig} from '@proxy/observability';

/**
 * What the logger needs of the environment, read here and not from utils/env.ts: that parses the
 * whole environment on import and refuses an incomplete one, while the logger is imported by
 * nearly everything, including by tests that give a handler no environment at all. The variables
 * are still documented and checked in env-schema.ts, with the rest.
 */

// The root .env, as env.ts loads it; dotenv leaves a variable that is already set alone.
config({path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env'), quiet: true});

// An empty variable counts as unset, as Docker Compose passes an optional one it has no value for.
function read(name: string): string {
	return process.env[name] || '';
}

/** Which of Grafana's environments this server's lines and metrics are labelled with. */
export const envLabel: EnvLabel = read('NODE_ENV') === 'production' ? 'production' : 'development';

/** Grafana Cloud Loki, where the api ships its log when set; an empty address means stdout alone. */
export const lokiConfig: LokiConfig = {
	url: read('LOKI_URL').replace(/\/+$/, ''),
	userId: read('LOKI_USER_ID'),
	token: read('GRAFANA_CLOUD_TOKEN'),
};

/** Grafana Cloud's OTLP gateway, where the api pushes its metrics when set; nothing is pushed otherwise. */
export const metricsConfig: Pick<MetricsConfig, 'url' | 'userId' | 'token'> = {
	url: read('METRICS_OTLP_URL'),
	userId: read('METRICS_USER_ID'),
	token: read('GRAFANA_CLOUD_TOKEN'),
};

/** The team's Slack, where sign-ups and alerts are posted when set. */
export const slackConfig: Pick<SlackConfig, 'botToken' | 'channels'> = {
	botToken: read('SLACK_BOT_TOKEN'),
	channels: {
		alerts: read('SLACK_CHANNEL_ALERTS') || undefined,
		signups: read('SLACK_CHANNEL_SIGNUPS') || undefined,
	},
};

/** What Grafana's alert webhook has to carry to be taken (grafana-alert.ts); none, none is taken. */
export const grafanaWebhookSecret: string = read('GRAFANA_WEBHOOK_SECRET');
