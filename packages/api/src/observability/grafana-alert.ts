import type {Request, Response} from 'express';
import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {listOrganizationSlugs} from '@proxy/db/organization';
import {type FetchError, formatFetchError} from '@proxy/utils';
import {
	type LokiConfig,
	type LokiQueryParams,
	type LokiQueryResult,
	type LokiStream,
	type Notifier,
	type NotifyInput,
	queryLokiRange,
	type SlackChannel,
	slackChannels,
	type SlackSeverity,
} from '@proxy/observability';

import {timingSafeEqualString} from '../auth/session';
import {collectOrgIds, formatThreadBody, nameOrganizations, summarizeLokiStreams} from './alert-thread';
import {grafanaWebhookSecret, lokiConfig} from './config';
import {log} from './log';
import {notify} from './notify';

/**
 * Grafana's alerts, sent to `/internal/grafana-alert` by the contact point the observability
 * package's alerts define, with the secret as a bearer token. Each is posted to Slack, to the
 * channel its `channel` label names, and one that is firing with a `lokiQuery` annotation gets a
 * reply in its thread: the lines that tripped it, summed up (alert-thread.ts), the organizations
 * among them named by slug.
 */

const labelsSchema = z.record(z.string(), z.string());

const alertSchema = z.object({
	status: z.enum(['firing', 'resolved']),
	labels: labelsSchema.optional(),
	annotations: labelsSchema.optional(),
	startsAt: z.string().optional(),
	endsAt: z.string().optional(),
	generatorURL: z.string().optional(),
	fingerprint: z.string().optional(),
});

// Grafana's webhook, the Alertmanager form:
// https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/
export const grafanaWebhookSchema = z.object({
	status: z.enum(['firing', 'resolved']),
	alerts: z.array(alertSchema),
	commonLabels: labelsSchema.optional(),
	commonAnnotations: labelsSchema.optional(),
});

export type GrafanaAlert = z.infer<typeof alertSchema>;

function severityOf(label: string | undefined): SlackSeverity {
	if (label === 'critical' || label === 'error') {
		return 'error';
	}
	if (label === 'warning' || label === 'warn') {
		return 'warn';
	}
	return 'info';
}

const KNOWN_CHANNELS: ReadonlySet<string> = new Set<string>(slackChannels);

// An unlabelled rule still reaches someone.
function channelOf(label: string | undefined): SlackChannel {
	return label && KNOWN_CHANNELS.has(label) ? (label as SlackChannel) : 'alerts';
}

/**
 * The alert with the group's labels and annotations folded in: Grafana moves what every alert
 * of a group shares, such as a rule's `lokiQuery`, up to the group.
 */
export function mergeAlert(alert: GrafanaAlert, commonLabels: Record<string, string> | undefined, commonAnnotations: Record<string, string> | undefined): GrafanaAlert {
	return {
		...alert,
		labels: {...commonLabels, ...alert.labels},
		annotations: {...commonAnnotations, ...alert.annotations},
	};
}

/** The alert as a Slack message: its summary as the title, its description as the body. */
export function toNotifyInput(alert: GrafanaAlert): NotifyInput {
	const labels = alert.labels ?? {};
	const annotations = alert.annotations ?? {};
	const name = labels.alertname ?? 'Unknown alert';
	const resolved = alert.status === 'resolved';
	const summary = annotations.summary ?? name;

	const ctx: Record<string, unknown> = {alertname: name, status: alert.status};
	if (labels.severity) {
		ctx.severity = labels.severity;
	}
	if (alert.startsAt) {
		ctx.startsAt = alert.startsAt;
	}
	if (alert.generatorURL) {
		ctx.url = alert.generatorURL;
	}

	return {
		channel: channelOf(labels.channel),
		title: resolved ? `[RESOLVED] ${summary}` : summary,
		body: annotations.description,
		// Good news, whatever the rule's severity.
		severity: resolved ? 'info' : severityOf(labels.severity),
		ctx,
	};
}

// The lines that tripped a rule sit in its window before `startsAt`, so the query reaches that
// far back from it: as far as the errors rule looks.
const THREAD_LOOKBACK_MS = 5 * 60 * 1000;
const THREAD_LINE_LIMIT = 500;
// The slug lookup is cut short: a database outage is itself what alerts, and the thread shouldn't
// wait on the pool while it is.
const SLUG_LOOKUP_TIMEOUT_MS = 2_000;
const NS_PER_MS = BigInt(1_000_000);

export interface PostAlertDeps {
	notifier: Notifier;
	queryLoki: (config: LokiConfig, params: LokiQueryParams) => Promise<Result<LokiQueryResult, FetchError>>;
	lokiConfig: LokiConfig;
	resolveOrgSlugs: (orgIds: string[]) => Promise<Map<string, string>>;
	now: () => number;
	logWarn: (msg: string, ctx?: Record<string, unknown>) => void;
}

export async function resolveOrgSlugsViaDb(orgIds: string[], timeoutMs = SLUG_LOOKUP_TIMEOUT_MS): Promise<Map<string, string>> {
	if (orgIds.length === 0) {
		return new Map();
	}
	const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs).unref());
	const won = await Promise.race([listOrganizationSlugs(orgIds), timeout]);
	if (won === 'timeout') {
		log.warn('alert thread: organization lookup timed out', {timeoutMs, count: orgIds.length});
		return new Map();
	}
	if (won.isErr()) {
		log.warn('alert thread: organization lookup failed', {kind: won.error.kind});
		return new Map();
	}
	return new Map(won.value.map((org) => [org.id, org.slug]));
}

const defaultDeps: PostAlertDeps = {
	notifier: notify,
	queryLoki: queryLokiRange,
	lokiConfig,
	resolveOrgSlugs: resolveOrgSlugsViaDb,
	now: () => Date.now(),
	logWarn: (msg, ctx) => log.warn(msg, ctx),
};

function streamsOf(result: LokiQueryResult): LokiStream[] {
	return result.data.resultType === 'streams' ? result.data.result : [];
}

/**
 * Posts the alert, and, firing with a `lokiQuery`, the lines that tripped it as a reply in its
 * thread. Never throws: what goes wrong is logged, so a slow Slack or Loki can't hold the
 * webhook's answer up, which would have Grafana send the alert again.
 */
export async function postAlertWithThread(alert: GrafanaAlert, deps: PostAlertDeps = defaultDeps): Promise<void> {
	const input = toNotifyInput(alert);
	const trace = {alertname: alert.labels?.alertname, status: alert.status, channel: input.channel};

	const parent = await deps.notifier.notify(input);
	if (!parent) {
		deps.logWarn('alert thread: alert was not posted', trace);
		return;
	}

	const lokiQuery = alert.annotations?.lokiQuery;
	if (alert.status !== 'firing' || !lokiQuery || !deps.lokiConfig.url) {
		return;
	}

	const endMs = deps.now();
	const startsAtMs = alert.startsAt ? Date.parse(alert.startsAt) : NaN;
	const anchorMs = Number.isFinite(startsAtMs) ? startsAtMs : endMs;
	const queried = await deps.queryLoki(deps.lokiConfig, {
		query: lokiQuery,
		startNs: BigInt(anchorMs - THREAD_LOOKBACK_MS) * NS_PER_MS,
		endNs: BigInt(endMs) * NS_PER_MS,
		limit: THREAD_LINE_LIMIT,
		direction: 'backward',
	});
	if (queried.isErr()) {
		deps.logWarn('alert thread: loki query failed', {...trace, error: formatFetchError(queried.error), lokiQuery});
		return;
	}

	const summary = summarizeLokiStreams(streamsOf(queried.value));
	if (summary.totalLines === 0) {
		return;
	}
	nameOrganizations(summary, await deps.resolveOrgSlugs(collectOrgIds(summary)));

	const reply = await deps.notifier.notify({
		channel: input.channel,
		title: `${summary.totalLines} log line${summary.totalLines === 1 ? '' : 's'} in ${summary.groups.length} group${summary.groups.length === 1 ? '' : 's'}`,
		body: formatThreadBody(summary),
		severity: 'info',
		threadTs: parent.ts,
	});
	if (!reply) {
		deps.logWarn('alert thread: reply was not posted', trace);
	}
}

function isAuthorized(request: Request): boolean {
	if (!grafanaWebhookSecret) {
		return false;
	}
	const header = request.headers.authorization;
	return typeof header === 'string' && timingSafeEqualString(header, `Bearer ${grafanaWebhookSecret}`);
}

export async function handleGrafanaAlertRoute(req: Request, res: Response): Promise<void> {
	if (!isAuthorized(req)) {
		res.status(401).json({error: 'unauthenticated'});
		return;
	}

	const parsed = grafanaWebhookSchema.safeParse(req.body);
	if (!parsed.success) {
		log.warn('grafana alert webhook: invalid payload', {issues: parsed.error.issues.slice(0, 5)});
		res.status(400).json({error: 'parse_error'});
		return;
	}

	const {alerts, commonLabels, commonAnnotations} = parsed.data;
	for (const alert of alerts) {
		void postAlertWithThread(mergeAlert(alert, commonLabels, commonAnnotations));
	}
	res.status(204).end();
}
