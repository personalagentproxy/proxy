import type {Action} from '@proxy/integrations';
import {useId, useRef, useState} from 'react';
import {PillButton} from '@/components/pill-button';
import {Checkbox} from '@proxy/ui/components/checkbox';
import {groupsOf, howManyOn} from '@/lib/access';
import {onSignInClick} from '@/lib/desktop';

type Props = {
	actions: Action[];
	// The actions agents get by default.
	defaults: string[];
	// Actions turned on or off.
	onChange: (actions: Record<string, boolean>) => Promise<void>;
	// The actions the connection's sign-in didn't cover: off and disabled until it is signed in again.
	unavailable?: string[];
	// The connection has no sign-in at all yet, so none of its actions is covered.
	signInNeeded?: boolean;
};

// The actions, one under another, a line between them, spaced by the list rather than each row,
// so the list sits as tight to what holds it as anything else does.
const ROWS = 'flex flex-col divide-y divide-border/60 *:py-3 *:first:pt-0 *:last:pb-0';

// A connection's defaults as a list, as the welcome flow sets them for a connection just made,
// before there are agents to set beside them (a connection's own page has them in a grid,
// access-grid.tsx): one checkbox per action, the only control for it, under the name of the part
// of the provider it belongs to where the integration groups them, as Google's are Gmail's,
// Calendar's, Drive's, Contacts' and Tasks', each saying how many are on, and above them all how
// many are on of all of them, with one button turning every action on, or off once all are. An
// action the connection's sign-in didn't cover is off whatever is set, its checkbox disabled.
export function ConnectionAccess({
	actions,
	defaults,
	onChange,
	unavailable = [],
	signInNeeded = false,
}: Props) {
	// A connection's actions show on more than one page section, so the ids need their own prefix.
	const idPrefix = useId();
	// Keep the control responsive while its change is saved and the route's data is reloaded.
	const [pending, setPending] = useState<Partial<Record<string, boolean>>>({});
	const queues = useRef<Partial<Record<string, Promise<void>>>>({});
	const rangeAnchor = useRef<string | null>(null);
	const isUnavailable = (id: string) => unavailable.includes(id);
	const isOn = (id: string) => !isUnavailable(id) && (pending[id] ?? defaults.includes(id));
	// Shows the actions as `checked` until `save` is done, after whatever was already saving for
	// any of them, so clicks are saved in the order they were made.
	const queueChange = (actionIds: string[], checked: boolean, save: () => Promise<void>) => {
		if (actionIds.length === 0) {
			return;
		}

		setPending((current) => ({
			...current,
			...Object.fromEntries(actionIds.map((id) => [id, checked])),
		}));

		const previous = Promise.all(
			actionIds.map((id) => (queues.current[id] ?? Promise.resolve()).catch(() => undefined)),
		);
		const request = previous.then(save);
		for (const id of actionIds) {
			queues.current[id] = request;
		}
		const settle = () => {
			const settled = actionIds.filter((id) => queues.current[id] === request);
			if (settled.length === 0) {
				return;
			}

			for (const id of settled) {
				delete queues.current[id];
			}
			setPending((current) => {
				const next = {...current};
				for (const id of settled) {
					delete next[id];
				}
				return next;
			});
		};
		void request.then(settle, settle);
	};
	const change = (actionId: string, checked: boolean) => {
		queueChange([actionId], checked, () => onChange({[actionId]: checked}));
	};
	const changeRange = (actionId: string, checked: boolean, shiftKey: boolean) => {
		const anchorIndex = actions.findIndex((action) => action.id === rangeAnchor.current);
		const actionIndex = actions.findIndex((action) => action.id === actionId);
		if (!shiftKey || anchorIndex === -1 || actionIndex === -1) {
			rangeAnchor.current = actionId;
			change(actionId, checked);
			return;
		}

		const first = Math.min(anchorIndex, actionIndex);
		const last = Math.max(anchorIndex, actionIndex);
		const changedActions = actions
			.slice(first, last + 1)
			.filter((action) => !isUnavailable(action.id))
			.filter((action) => isOn(action.id) !== checked || pending[action.id] !== undefined);
		queueChange(
			changedActions.map((action) => action.id),
			checked,
			() => onChange(Object.fromEntries(changedActions.map((action) => [action.id, checked]))),
		);
	};

	const row = (action: Action) => {
		const checked = isOn(action.id);
		const blocked = checked && action.requires !== undefined && !isOn(action.requires);
		const required = actions.find((candidate) => candidate.id === action.requires);
		const inputId = `${idPrefix}-${action.id}`;
		const labelId = `${inputId}-label`;
		const descriptionId = `${inputId}-description`;
		const disabled = isUnavailable(action.id);
		return (
			<li
				key={action.id}
				// Out in the gutter as any row.
				className="bleed flex items-start gap-3 text-sm"
			>
				{/* As tall as the label's line, the box centered on it. */}
				<span className="flex h-5 shrink-0 items-center">
					<Checkbox
						id={inputId}
						aria-labelledby={labelId}
						aria-describedby={descriptionId}
						checked={checked}
						disabled={disabled}
						onMouseDown={(event) => {
							if (disabled || !event.shiftKey || event.button !== 0) {
								return;
							}

							event.preventDefault();
							event.currentTarget.focus();
						}}
						onCheckedChange={(next, details) =>
							changeRange(
								action.id,
								next,
								details.event instanceof MouseEvent && details.event.shiftKey,
							)
						}
					/>
				</span>
				<div
					className="flex min-w-0 flex-1 flex-col gap-0.5"
					onMouseDown={(event) => {
						if (disabled || !event.shiftKey) {
							return;
						}

						event.preventDefault();
						document.getElementById(inputId)?.focus();
					}}
					onClick={(event) => {
						if (disabled) {
							return;
						}

						if (event.shiftKey) {
							event.preventDefault();
							changeRange(action.id, !checked, true);
							return;
						}

						document.getElementById(inputId)?.focus();
						changeRange(action.id, !checked, false);
					}}
				>
					<span id={labelId} className="flex items-center gap-2">
						{action.label}
						{action.risk === 'high' && (
							<span className="shrink-0 text-xs text-destructive">High risk</span>
						)}
					</span>
					<span id={descriptionId} className="text-muted-foreground">
						{action.description}
						{blocked && required && ` · Off while ${required.label} is off`}
						{isUnavailable(action.id) &&
							(signInNeeded
								? ' · Sign in to allow it.'
								: ' · Not allowed at sign-in. Sign in again to allow it.')}
					</span>
				</div>
			</li>
		);
	};

	// Every action the sign-in covered, those the sign-in didn't left off whatever is set.
	const settable = actions.filter((action) => !isUnavailable(action.id));
	const allOn = settable.length > 0 && settable.every((action) => isOn(action.id));
	const setAll = (next: boolean) => {
		const changing = settable.filter((action) => isOn(action.id) !== next).map(({id}) => id);
		queueChange(changing, next, () =>
			onChange(Object.fromEntries(changing.map((id) => [id, next]))),
		);
	};
	// How many of all the actions are on, with the button that turns every one on or off, on one
	// line above them.
	const all = (
		<div className="flex h-8 items-center justify-between gap-3 text-sm">
			<span className="text-muted-foreground">
				{howManyOn(actions.filter((action) => isOn(action.id)).length, actions.length)}
			</span>
			{settable.length > 1 && (
				<PillButton variant="ghost" onClick={() => setAll(!allOn)}>
					{allOn ? 'Disable all' : 'Enable all'}
				</PillButton>
			)}
		</div>
	);

	const groups = groupsOf(actions);
	if (groups.length === 1 && groups[0]?.name === undefined) {
		return (
			<div className="flex flex-col gap-2">
				{all}
				<ul className={ROWS}>{actions.map(row)}</ul>
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-6">
			{all}
			{groups.map((group, index) => {
				const headingId = `${idPrefix}-group-${index}`;
				const on = group.actions.filter((action) => isOn(action.id)).length;
				return (
					<section
						key={group.name ?? 'other'}
						aria-labelledby={headingId}
						className="flex flex-col gap-2"
					>
						<div className="flex h-8 items-center justify-between gap-3 text-sm">
							<h3 id={headingId}>{group.name ?? 'Other'}</h3>
							<span className="text-muted-foreground">{howManyOn(on, group.actions.length)}</span>
						</div>
						<ul className={ROWS}>{group.actions.map(row)}</ul>
					</section>
				);
			})}
		</div>
	);
}

// Under a connection's permissions: when its sign-in didn't cover some actions (`unavailable`),
// when it has none yet, as one moved over from a custom MCP server may not (`needed`), or, for an
// integration that says nothing of who signed in, so only this page renews its connection, always
// (`renew`). Signing in again, or a new API key where the integration takes one (`onUseKey`),
// gives the same connection its new credential, its defaults and every agent's settings kept.
export function SignInAgain({
	href,
	reason,
	onUseKey,
}: {
	href: string;
	reason: 'unavailable' | 'needed' | 'renew';
	onUseKey?: () => void;
}) {
	const link = 'text-foreground underline underline-offset-4';
	const useKey = onUseKey && (
		<button type="button" onClick={onUseKey} className={link}>
			use an API key
		</button>
	);
	if (reason === 'needed') {
		return (
			<p className="text-sm text-muted-foreground">
				This connection isn't signed in yet, so agents can't use it.{' '}
				<a href={href} onClick={onSignInClick} className={link}>
					Sign in
				</a>
				{useKey && <>, or {useKey},</>} to start.
			</p>
		);
	}
	if (reason === 'renew') {
		return (
			<p className="text-sm text-muted-foreground">
				<a href={href} onClick={onSignInClick} className={link}>
					Sign in again
				</a>
				{useKey && <>, or {useKey}</>}, keeping every agent's settings.
			</p>
		);
	}
	return (
		<p className="text-sm text-muted-foreground">
			Some actions weren't allowed when this account was signed in.{' '}
			<a href={href} onClick={onSignInClick} className={link}>
				Sign in again
			</a>{' '}
			to allow them.
		</p>
	);
}
