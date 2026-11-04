import type {LokiStream} from '@proxy/observability';

/**
 * The lines that tripped an alert, summed up for its Slack thread: grouped by service and
 * message, so one noisy error is one line with a count, each group with the distinct values of
 * its fields, so the thread says which organizations and requests it hit without listing every
 * line.
 */

// The stream's labels and the line's own bookkeeping, which say nothing in a summary.
const NOISE_FIELDS: ReadonlySet<string> = new Set(['msg', 'service', 'service_name', 'env', 'level', 'detected_level', 'ts', 'clientTs', 'userAgent', 'stack']);

export interface FieldValues {
	// The distinct values seen, in the order seen.
	values: Set<string>;
	// Whether the cap was hit, so there were more than `values.size`.
	truncated: boolean;
}

export interface LineGroup {
	service: string;
	msg: string;
	count: number;
	fields: Map<string, FieldValues>;
}

export interface SummarizeOptions {
	maxGroups?: number;
	maxValuesPerField?: number;
}

export interface Summary {
	groups: LineGroup[];
	totalLines: number;
	omittedGroups: number;
}

function valueToString(value: unknown): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	const json = JSON.stringify(value);
	return json === undefined ? '[unserializable]' : json;
}

function recordField(group: LineGroup, key: string, value: string, maxValues: number): void {
	const entry = group.fields.get(key) ?? {values: new Set<string>(), truncated: false};
	group.fields.set(key, entry);
	if (entry.values.has(value)) {
		return;
	}
	if (entry.values.size >= maxValues) {
		entry.truncated = true;
		return;
	}
	entry.values.add(value);
}

function parseLine(line: string): Record<string, unknown> | null {
	try {
		const json: unknown = JSON.parse(line);
		if (json && typeof json === 'object' && !Array.isArray(json)) {
			return json as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Groups the streams' lines by service and message. The message is the line's `msg`, as the
 * server logger writes it; a line that isn't JSON is its own group, so it still shows.
 */
export function summarizeLokiStreams(streams: LokiStream[], options: SummarizeOptions = {}): Summary {
	const maxGroups = options.maxGroups ?? 10;
	// Enough that "247 distinct organizations" stays a number, few enough that request ids can't
	// take the memory; past the cap, "50+ distinct".
	const maxValuesPerField = options.maxValuesPerField ?? 50;

	const groups = new Map<string, LineGroup>();
	let totalLines = 0;

	for (const stream of streams) {
		const service = stream.stream.service ?? 'unknown';
		for (const [, line] of stream.values) {
			totalLines += 1;
			const parsed = parseLine(line);
			const msg = parsed && typeof parsed.msg === 'string' ? parsed.msg : line.slice(0, 200);
			const key = `${service}::${msg}`;
			const group = groups.get(key) ?? {service, msg, count: 0, fields: new Map()};
			groups.set(key, group);
			group.count += 1;
			if (!parsed) {
				continue;
			}
			for (const [field, value] of Object.entries(parsed)) {
				if (NOISE_FIELDS.has(field)) {
					continue;
				}
				recordField(group, field, valueToString(value), maxValuesPerField);
			}
		}
	}

	const sorted = Array.from(groups.values()).sort((a, b) => b.count - a.count);
	const top = sorted.slice(0, maxGroups);
	return {groups: top, totalLines, omittedGroups: Math.max(0, sorted.length - top.length)};
}

/** Every organization id across the groups, to name them in one query. */
export function collectOrgIds(summary: Summary): string[] {
	const ids = new Set<string>();
	for (const group of summary.groups) {
		for (const id of group.fields.get('orgId')?.values ?? []) {
			ids.add(id);
		}
	}
	return Array.from(ids);
}

/** Names the organizations by slug where one is known, as `org`; an unknown id stays as it is. */
export function nameOrganizations(summary: Summary, slugs: Map<string, string>): void {
	for (const group of summary.groups) {
		const ids = group.fields.get('orgId');
		if (!ids) {
			continue;
		}
		const named: FieldValues = {values: new Set(), truncated: ids.truncated};
		for (const id of ids.values) {
			named.values.add(slugs.get(id) ?? id);
		}
		group.fields.delete('orgId');
		group.fields.set('org', named);
	}
}

// Up to three values are listed; from four on, a count with a sample.
const LIST_UP_TO = 3;
const SAMPLE = 3;

function formatValues(entry: FieldValues): string {
	const list = Array.from(entry.values);
	if (list.length <= LIST_UP_TO && !entry.truncated) {
		return list.join(', ');
	}
	const samples = list.slice(0, SAMPLE).join(', ');
	const distinct = entry.truncated ? `${list.length}+ distinct` : `${list.length} distinct`;
	return `${distinct} (${samples}${list.length > SAMPLE ? ', …' : ''})`;
}

// Slack takes 3000 characters in a section.
const BLOCK_LIMIT = 2900;

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The summary as one Slack section, in mrkdwn, within the block's limit. */
export function formatThreadBody(summary: Summary): string {
	if (summary.groups.length === 0) {
		return '_No matching log lines in the window._';
	}

	const omitted = summary.omittedGroups > 0 ? ` (+${plural(summary.omittedGroups, 'group')} omitted)` : '';
	const parts = [`*${plural(summary.totalLines, 'log line')}* in *${plural(summary.groups.length, 'group')}*${omitted}`, ''];
	for (const group of summary.groups) {
		parts.push(`*${group.count}×* \`${group.msg}\` _(${group.service})_`);
		// Sorted, so the same alert reads the same way each time.
		const fields = Array.from(group.fields.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [key, entry] of fields) {
			parts.push(`  • *${key}:* ${formatValues(entry)}`);
		}
		parts.push('');
	}

	const body = parts.join('\n').trimEnd();
	if (body.length <= BLOCK_LIMIT) {
		return body;
	}
	return `${body.slice(0, BLOCK_LIMIT - 20)}\n_…truncated_`;
}
