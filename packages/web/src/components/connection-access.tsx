import type {Action, OwnSettings} from '@proxy/integrations';
import {CheckCheckIcon, Undo2Icon} from 'lucide-react';
import {useId, useLayoutEffect, useRef, useState} from 'react';
import {IconButton} from '@/components/icon-button';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {Checkbox} from '@proxy/ui/components/checkbox';
import {cn} from '@proxy/ui/lib/utils';

type Props = {
	actions: Action[];
	// The actions agents get by default.
	defaults: string[];
	// An agent's own settings. Left out on a connection's page, where the defaults themselves are set.
	own?: OwnSettings;
	// On a connection's page: how many agents have a setting of their own, by action.
	differing?: Partial<Record<string, number>>;
	// Actions turned on or off; null returns an agent's action to the default.
	onChange: (actions: Record<string, boolean | null>) => Promise<void>;
	// On an agent's page: makes the agent's own setting for an action the connection's default.
	onMakeDefault?: (actionId: string, allowed: boolean) => Promise<void>;
	// The actions the connection's sign-in didn't cover: off and disabled until it is signed in again.
	unavailable?: string[];
	// The connection has no sign-in at all yet, so none of its actions is covered.
	signInNeeded?: boolean;
	// Shown but not changed: a shared connection by a member who only uses it.
	readOnly?: boolean;
};

// The actions, one under another, spaced by the list rather than each row, so the list sits
// as tight to what holds it as anything else does.
const ROWS = 'flex flex-col gap-4';

// A connection's access, the way an editor shows its settings: one checkbox per action, the only
// control for it, under the name of the part of the provider it belongs to where the integration
// groups them, as Google's are Gmail's, Calendar's, Drive's and Contacts', each saying how many are
// on, and one button above them all turning every action on, or off once all are. On an agent's
// page every action starts on the connection's default; one the agent has its own setting for is
// marked with a bar, a button that makes it the default for every agent, and one that resets it to
// the default. An action the connection's sign-in didn't cover is off whatever is set, its checkbox
// disabled, and can't be made the default from here, since it shows off whatever the agent's own
// setting is.
export function ConnectionAccess({
	actions,
	defaults,
	own,
	differing,
	onChange,
	onMakeDefault,
	unavailable = [],
	signInNeeded = false,
	readOnly = false,
}: Props) {
	// A connection's actions show on more than one page section, so the ids need their own prefix.
	const idPrefix = useId();
	// Keep the control responsive while its change is saved and the route's data is reloaded.
	const [pending, setPending] = useState<Partial<Record<string, boolean>>>({});
	const queues = useRef<Partial<Record<string, Promise<void>>>>({});
	const rangeAnchor = useRef<string | null>(null);
	// The latest settings, for a change saved after others finished, read when it runs rather than
	// when it was clicked: kept as the render commits, before a queued save can run, which a passive
	// effect, run later, wouldn't be.
	const defaultsRef = useRef(defaults);
	const ownRef = useRef(own);
	useLayoutEffect(() => {
		defaultsRef.current = defaults;
		ownRef.current = own;
	});
	const isDefault = (id: string) => defaults.includes(id);
	const isUnavailable = (id: string) => unavailable.includes(id);
	const storedIsOn = (id: string) => (own ? (own[id] ?? isDefault(id)) : isDefault(id));
	const isOn = (id: string) => !isUnavailable(id) && (pending[id] ?? storedIsOn(id));
	const isOwn = (id: string) => own?.[id] !== undefined;
	// On an agent's page, an action that matches the default follows it rather than being stored.
	const setting = (id: string, next: boolean): boolean | null => {
		if (ownRef.current && next === defaultsRef.current.includes(id)) {
			return null;
		}
		return next;
	};
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
		queueChange([actionId], checked, () => onChange({[actionId]: setting(actionId, checked)}));
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
			() =>
				onChange(
					Object.fromEntries(
						changedActions.map((action) => [action.id, setting(action.id, checked)]),
					),
				),
		);
	};

	const row = (action: Action) => {
		const checked = isOn(action.id);
		const blocked = checked && action.requires !== undefined && !isOn(action.requires);
		const required = actions.find((candidate) => candidate.id === action.requires);
		const others = differing?.[action.id] ?? 0;
		const inputId = `${idPrefix}-${action.id}`;
		const labelId = `${inputId}-label`;
		const descriptionId = `${inputId}-description`;
		const disabled = readOnly || isUnavailable(action.id);
		return (
			<li
				key={action.id}
				className={cn(
					// Out in the gutter as any row, where a setting of the agent's own shows as a stripe.
					'bleed flex items-start gap-3 text-sm',
					isOwn(action.id) && 'shadow-[inset_2px_0_0_var(--color-primary)]',
				)}
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
							<Badge variant="destructive" className="font-normal">
								High risk
							</Badge>
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
				<span className="flex shrink-0 items-center gap-2 text-muted-foreground">
					{others > 0 && `Changed for ${others} ${others === 1 ? 'agent' : 'agents'}`}
					{isOwn(action.id) && onMakeDefault && !isUnavailable(action.id) && (
						<IconButton
							label="Make this the default for every agent"
							onClick={() =>
								queueChange([action.id], checked, () => onMakeDefault(action.id, checked))
							}
						>
							<CheckCheckIcon />
						</IconButton>
					)}
					{isOwn(action.id) && (
						<IconButton
							label="Reset to default"
							onClick={() =>
								queueChange([action.id], isDefault(action.id), () => onChange({[action.id]: null}))
							}
						>
							<Undo2Icon />
						</IconButton>
					)}
				</span>
			</li>
		);
	};

	// Every action the sign-in covered, those the sign-in didn't left off whatever is set.
	const settable = actions.filter((action) => !isUnavailable(action.id));
	const allOn = settable.length > 0 && settable.every((action) => isOn(action.id));
	const setAll = (next: boolean) => {
		const changing = settable.filter((action) => isOn(action.id) !== next).map(({id}) => id);
		queueChange(changing, next, () =>
			onChange(Object.fromEntries(changing.map((id) => [id, setting(id, next)]))),
		);
	};
	const all = settable.length > 1 && (
		<Button
			variant="outline"
			size="sm"
			className="self-start"
			disabled={readOnly}
			onClick={() => setAll(!allOn)}
		>
			{allOn ? 'Disable all' : 'Enable all'}
		</Button>
	);

	const groups = groupsOf(actions);
	if (groups.length === 1 && groups[0]?.name === undefined) {
		return (
			<div className="flex flex-col gap-4">
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

// "2 of 7 on", or all or none.
function howManyOn(on: number, total: number): string {
	if (on === 0) {
		return 'None on';
	}
	if (on === total) {
		return 'All on';
	}
	return `${on} of ${total} on`;
}

type Group = {name: string | undefined; actions: Action[]};

// The actions in runs of the group each names, in the catalog's order.
function groupsOf(actions: Action[]): Group[] {
	const groups: Group[] = [];
	for (const action of actions) {
		const last = groups.at(-1);
		if (last && last.name === action.group) {
			last.actions.push(action);
			continue;
		}
		groups.push({name: action.group, actions: [action]});
	}
	return groups;
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
				<a href={href} className={link}>
					Sign in
				</a>
				{useKey && <>, or {useKey},</>} to start.
			</p>
		);
	}
	if (reason === 'renew') {
		return (
			<p className="text-sm text-muted-foreground">
				<a href={href} className={link}>
					Sign in again
				</a>
				{useKey && <>, or {useKey}</>}, keeping every agent's settings.
			</p>
		);
	}
	return (
		<p className="text-sm text-muted-foreground">
			Some actions weren't allowed when this account was signed in.{' '}
			<a href={href} className="text-foreground underline underline-offset-4">
				Sign in again
			</a>{' '}
			to allow them.
		</p>
	);
}
