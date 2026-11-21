import type {AgentLogin} from '@proxy/contracts/agents';
import type {Action, OwnSettings} from '@proxy/integrations';
import {LockIcon} from 'lucide-react';
import {type ReactNode, useState} from 'react';
import {Link} from 'react-router';
import {AgentLogo} from '@/components/brand-logo';
import {Checkbox} from '@proxy/ui/components/checkbox';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';
import {groupsOf} from '@/lib/access';
import {useOrgSlug} from '@/hooks/use-org';

/**
 * An agent that reaches the connection, as a column: its own settings there, and who may change
 * them, by name, where the person may not; null where they may.
 */
export type GridAgent = {agent: AgentLogin; own: OwnSettings; setBy: string | null};

type Props = {
	actions: Action[];
	// The actions agents get by default.
	defaults: string[];
	// The agents that reach the connection, a column each.
	agents: GridAgent[];
	// The actions the connection's sign-in didn't cover: off and disabled for everyone until it is
	// signed in again.
	unavailable: string[];
	// The connection has no sign-in at all yet, so none of its actions is covered.
	signInNeeded: boolean;
	// Who may change the defaults, by name, where the person may not, who sees them; null where they may.
	defaultsSetBy: string | null;
	// Turns default actions on or off.
	onChangeDefaults: (actions: Record<string, boolean>) => Promise<void>;
	// Gives an agent settings of its own for actions; null returns one to the default.
	onChangeAgent: (agentId: string, actions: Record<string, boolean | null>) => Promise<void>;
	// On an agent's own page, where its column needn't lead back to it or show whose it is: the
	// agents' names stand alone, without their logos, and are not links.
	unlinked?: boolean;
	// Under a heading the page gives it, with the columns' names (`AccessGridColumns`): actions the
	// integration doesn't group have no heading row of the grid's own. Groups keep theirs.
	headed?: boolean;
	// A first row, All, whose box in each column turns every action the sign-in allows on or off
	// there at once: under Default the defaults, which leave agents' settings of their own as they
	// are; under an agent its settings. Where the integration groups its actions, each group has one
	// over its own. Above the grid, a button turns everything on, or off once all is: every action
	// the sign-in allows, by default and for every agent the person may change.
	all?: boolean;
};

// The first column is the action; every other one a box, the same width, so the boxes line up.
const BOX = 'w-16 px-1 text-center align-top';
// A column's heading, on the line the agents' names are on.
const HEAD = 'pb-2 align-bottom text-xs font-normal';
const DEFAULT = 'default';

// A connection's access as a grid: an action a row, and a column each for the default and for
// every agent that reaches the connection, so who can do what reads across. Where the integration
// groups its actions, as Google's are Gmail's or Drive's, each group is a part of the grid under a
// heading row of its own, the group's name over the actions and the columns named again, so they
// are never far above the boxes; ungrouped, the one heading says Action, unless the page heads the
// grid itself (`headed`). A box under Default sets
// what an agent gets unless it has a setting of its own; a box under an agent gives it one, drawn
// on a filled square that says on hover what it does to the default, and ticking it back to what
// the default says drops the setting, so the agent follows the default again. An action the connection's sign-in didn't cover is off and
// disabled for everyone. Wider than its page with many agents, it scrolls sideways under the
// action's name.
export function AccessGrid({
	actions,
	defaults,
	agents,
	unavailable,
	signInNeeded,
	defaultsSetBy,
	onChangeDefaults,
	onChangeAgent,
	unlinked = false,
	headed = false,
	all = false,
}: Props) {
	const org = useOrgSlug();
	const mayChangeDefaults = defaultsSetBy === null;
	// What a box shows while its change is saved and the page's data loaded again, by column and
	// action.
	const [pending, setPending] = useState<Partial<Record<string, boolean>>>({});
	const key = (column: string, actionId: string) => `${column}:${actionId}`;
	const isUnavailable = (id: string) => unavailable.includes(id);
	const isDefault = (id: string) =>
		!isUnavailable(id) && (pending[key(DEFAULT, id)] ?? defaults.includes(id));
	const isOwn = ({own}: GridAgent, id: string) => own[id] !== undefined;
	const isOn = (column: GridAgent, id: string) =>
		!isUnavailable(id) &&
		// An agent that follows the default follows it as soon as the default's box is clicked, not
		// once the change is saved and the page loaded again.
		(pending[key(column.agent.id, id)] ?? column.own[id] ?? isDefault(id));

	// Shows the boxes as `next` until `save` is done.
	const change = async (boxes: string[], next: boolean, save: () => Promise<void>) => {
		setPending((current) => ({...current, ...Object.fromEntries(boxes.map((box) => [box, next]))}));
		try {
			await save();
		} finally {
			setPending((current) =>
				Object.fromEntries(Object.entries(current).filter(([box]) => !boxes.includes(box))),
			);
		}
	};
	// What an agent's box saves: what the default says is no setting of the agent's own, so the agent
	// follows the default.
	const ownSetting = (actionId: string, next: boolean, defaultOn = isDefault(actionId)) =>
		next === defaultOn ? null : next;

	// Every action the sign-in allows, and the columns the person may change: the defaults where
	// they are theirs to set, and each agent that is.
	const available = actions.filter((action) => !isUnavailable(action.id)).map(({id}) => id);
	const changeable = agents.filter((column) => column.setBy === null);
	const everythingOn =
		available.length > 0 &&
		available.every(
			(id) =>
				(!mayChangeDefaults || isDefault(id)) && changeable.every((column) => isOn(column, id)),
		);
	// Turns every action the sign-in allows on, or off once all are, in every column the person may
	// change: the defaults, and each agent, whose settings of its own that would say the same as the
	// default are dropped, so it follows the default again.
	const setEverything = (next: boolean) => {
		const defaultAfter = (id: string) => (mayChangeDefaults ? next : isDefault(id));
		const defaultIds = mayChangeDefaults ? available.filter((id) => isDefault(id) !== next) : [];
		if (defaultIds.length > 0) {
			void change(
				defaultIds.map((id) => key(DEFAULT, id)),
				next,
				() => onChangeDefaults(Object.fromEntries(defaultIds.map((id) => [id, next]))),
			);
		}
		for (const column of changeable) {
			// Only what its settings of its own would change: one that follows the default and will
			// say `next` with it is left alone.
			const ids = available.filter((id) => {
				const setting = ownSetting(id, next, defaultAfter(id));
				return setting === null ? isOwn(column, id) : column.own[id] !== setting;
			});
			if (ids.length === 0) {
				continue;
			}
			void change(
				ids.map((id) => key(column.agent.id, id)),
				next,
				() =>
					onChangeAgent(
						column.agent.id,
						Object.fromEntries(ids.map((id) => [id, ownSetting(id, next, defaultAfter(id))])),
					),
			);
		}
	};

	// The All row over some actions, a whole group's where the integration groups them: in each
	// column ticked when every one the sign-in allows is on there, a dash when some are. On a band of
	// its own, so it reads as a control over the rows under it rather than as one more action: its text
	// on the line with theirs, the band out into the gutter (`--bleed`) as a row's hover is, a cell
	// at each end reaching there with a shadow, which a table cell has where a row has its margin.
	const allRow = (over: Action[], group: string | undefined) => {
		const available = over.filter((action) => !isUnavailable(action.id)).map(({id}) => id);
		const allBox = (on: (id: string) => boolean) => {
			const count = available.filter(on).length;
			return {
				checked: available.length > 0 && count === available.length,
				indeterminate: count > 0 && count < available.length,
			};
		};
		const name = group === undefined ? 'All' : `All of ${group}`;
		const cell = 'bg-(--band) py-1.5 align-middle';
		const left = 'rounded-l-md shadow-[calc(var(--bleed)*-1)_0_0_0_var(--band)]';
		const right = 'rounded-r-md shadow-[var(--bleed)_0_0_0_var(--band)]';
		return (
			<tr className="border-t border-border/60 [--band:color-mix(in_oklab,var(--color-muted)_60%,transparent)]">
				<th scope="row" className={cn(cell, left, 'text-left font-medium')}>
					All
				</th>
				<td className={cn(BOX, cell, agents.length === 0 && right)}>
					<Box
						label={`${name} by default`}
						{...allBox(isDefault)}
						setBy={defaultsSetBy}
						disabled={available.length === 0}
						onChange={(next) =>
							void change(
								available.map((id) => key(DEFAULT, id)),
								next,
								() => onChangeDefaults(Object.fromEntries(available.map((id) => [id, next]))),
							)
						}
					/>
				</td>
				{agents.map((column, index) => (
					<td key={column.agent.id} className={cn(BOX, cell, index === agents.length - 1 && right)}>
						<Box
							label={`${name} for ${column.agent.name}`}
							{...allBox((id) => isOn(column, id))}
							setBy={column.setBy}
							disabled={available.length === 0}
							onChange={(next) =>
								void change(
									available.map((id) => key(column.agent.id, id)),
									next,
									() =>
										onChangeAgent(
											column.agent.id,
											Object.fromEntries(available.map((id) => [id, ownSetting(id, next)])),
										),
								)
							}
						/>
					</td>
				))}
			</tr>
		);
	};

	const row = (action: Action) => {
		const blocked =
			isDefault(action.id) && action.requires !== undefined && !isDefault(action.requires);
		const required = actions.find((candidate) => candidate.id === action.requires);
		return (
			<tr key={action.id} className="border-t border-border/60">
				<th scope="row" className="py-3 pr-3 text-left align-top font-normal">
					<span className="flex items-center justify-between gap-2">
						{action.label}
						{action.risk === 'high' && (
							<span className="shrink-0 text-xs text-destructive">High risk</span>
						)}
					</span>
					<span className="block text-muted-foreground">
						{action.description}
						{blocked && required && ` · Off while ${required.label} is off`}
						{isUnavailable(action.id) &&
							(signInNeeded
								? ' · Sign in to allow it.'
								: ' · Not allowed at sign-in. Sign in again to allow it.')}
					</span>
				</th>
				<td className={cn(BOX, 'py-3')}>
					<Box
						label={`${action.label} by default`}
						checked={isDefault(action.id)}
						setBy={defaultsSetBy}
						disabled={isUnavailable(action.id)}
						onChange={(next) =>
							void change([key(DEFAULT, action.id)], next, () =>
								onChangeDefaults({[action.id]: next}),
							)
						}
					/>
				</td>
				{agents.map((column) => (
					<td key={column.agent.id} className={cn(BOX, 'py-3')}>
						<Box
							label={`${action.label} for ${column.agent.name}`}
							checked={isOn(column, action.id)}
							own={isOwn(column, action.id)}
							setBy={column.setBy}
							disabled={isUnavailable(action.id)}
							onChange={(next) =>
								void change([key(column.agent.id, action.id)], next, () =>
									onChangeAgent(column.agent.id, {[action.id]: ownSetting(action.id, next)}),
								)
							}
						/>
					</td>
				))}
			</tr>
		);
	};

	const groups = groupsOf(actions);
	const everythingButton =
		all && available.length > 0 && (mayChangeDefaults || changeable.length > 0);
	return (
		<div className="flex flex-col gap-2">
			{/* Apart from the page's text over the grid, and close over the grid it acts on. */}
			{everythingButton && (
				<div className="flex pt-2">
					<PillButton onClick={() => setEverything(!everythingOn)}>
						{everythingOn ? 'Disable all' : 'Enable all'}
					</PillButton>
				</div>
			)}
			<div className="-mx-(--bleed) overflow-x-auto px-(--bleed)">
				<table className="w-full border-collapse text-sm">
					{groups.map((group, index) => {
						// Room above each part, over every heading of its row, the agents' logos being the
						// tallest: a little over the first part, less under the button that turns everything
						// on, more between two.
						const above = index > 0 ? 'pt-12' : everythingButton ? 'pt-2' : 'pt-4';
						return (
							<tbody key={group.name ?? 'all'}>
								{!(headed && group.name === undefined) && (
									<tr>
										<th
											scope="col"
											className={cn('min-w-56 pb-2 text-left align-bottom font-medium', above)}
										>
											{group.name ?? 'Action'}
										</th>
										<th scope="col" className={cn(BOX, HEAD, above)}>
											<DefaultHeading setBy={defaultsSetBy} />
										</th>
										{agents.map(({agent, setBy}) => (
											<th key={agent.id} scope="col" className={cn(BOX, HEAD, above)}>
												<AgentHeading
													agent={agent}
													setBy={setBy}
													to={unlinked ? null : `/${org}/agents/${agent.id}`}
												/>
											</th>
										))}
									</tr>
								)}
								{all && allRow(group.actions, group.name)}
								{group.actions.map(row)}
							</tbody>
						);
					})}
				</table>
			</div>
			{agents.length === 0 && (
				<p className="text-sm text-muted-foreground">No agent reaches this connection yet.</p>
			)}
		</div>
	);
}

/**
 * The grid's column names on their own, for a page that heads an ungrouped grid itself (`headed`),
 * as an agent's page does with the connection's name: Default and each agent by name, as wide as
 * the columns under them, at the end of the heading's line, and no taller than it, each with a lock
 * where the person may not change it.
 */
export function AccessGridColumns({
	agents,
	defaultsSetBy,
}: {
	agents: GridAgent[];
	defaultsSetBy: string | null;
}) {
	return (
		<span className="flex shrink-0 items-center text-xs">
			<span className="w-16 px-1 text-center">
				<DefaultHeading setBy={defaultsSetBy} />
			</span>
			{agents.map(({agent, setBy}) => (
				<span key={agent.id} className="w-16 px-1 text-center">
					<AgentHeading agent={agent} setBy={setBy} to={null} />
				</span>
			))}
		</span>
	);
}

// A column's name with a lock before it where the person may not change the column, saying on
// hover why (`says`).
function Locked({says, children}: {says: string | null; children: ReactNode}) {
	if (says === null) {
		return children;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="inline-flex max-w-full min-w-0 items-center justify-center gap-0.5" />
				}
			>
				<LockIcon aria-label={says} className="size-3 shrink-0 text-muted-foreground" />
				{children}
			</TooltipTrigger>
			<TooltipContent>{says}</TooltipContent>
		</Tooltip>
	);
}

// What the lock by Default says: only whoever shares the connection changes it, Default being what
// every agent on it follows, theirs too.
export const DEFAULT_LOCKED = 'Only the person sharing this connection can update the default';

function DefaultHeading({setBy}: {setBy: string | null}) {
	return <Locked says={setBy === null ? null : DEFAULT_LOCKED}>Default</Locked>;
}

// An agent's column heading: its logo over its name, a link to its page; with `to` null, on the
// agent's own page, its name alone, the page being about nothing else.
function AgentHeading({
	agent,
	setBy,
	to,
}: {
	agent: AgentLogin;
	setBy: string | null;
	to: string | null;
}) {
	const name = (
		<Locked says={setBy === null ? null : `Set by ${setBy}`}>
			<span title={agent.name} className="block min-w-0 truncate">
				{agent.name}
			</span>
		</Locked>
	);
	if (to === null) {
		return name;
	}
	return (
		<Link
			to={to}
			title={agent.name}
			className="flex flex-col items-center gap-1 rounded-md outline-none hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
		>
			<AgentLogo providerId={agent.providerId} />
			<span className="block w-14">{name}</span>
		</Link>
	);
}

// One box of the grid, centered in its column; an agent's own setting sits on a filled square,
// which says on hover what it does to the default. A box in a column the person may not change
// (`setBy`) reads as clearly as one they may, its state being what they came to see, and says on
// hover who changes it; one with nothing to set (`disabled`), as an action the sign-in didn't
// cover, is faded.
function Box({
	label,
	checked,
	indeterminate = false,
	own = false,
	setBy,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	indeterminate?: boolean;
	own?: boolean;
	setBy: string | null;
	disabled: boolean;
	onChange: (next: boolean) => void;
}) {
	const locked = setBy !== null && !disabled;
	const box = (
		<Checkbox
			aria-label={own ? `${label}, its own setting` : label}
			checked={checked}
			indeterminate={indeterminate}
			disabled={disabled}
			readOnly={setBy !== null}
			className={cn(setBy !== null && 'cursor-default')}
			onCheckedChange={(next) => onChange(next)}
		/>
	);
	const says = [
		...(own ? [`Overwrites default to ${checked ? 'on' : 'off'}`] : []),
		...(locked ? [`Set by ${setBy}`] : []),
	];
	if (says.length === 0) {
		return <span className="inline-flex size-7 items-center justify-center">{box}</span>;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						data-own={own ? '' : undefined}
						className={cn(
							'inline-flex size-7 items-center justify-center',
							own && 'rounded-md bg-muted ring-1 ring-border',
						)}
					/>
				}
			>
				{box}
			</TooltipTrigger>
			<TooltipContent>{says.join(' · ')}</TooltipContent>
		</Tooltip>
	);
}
