import type {Collection, OwnSettings} from '@proxy/integrations';
import {ChevronRightIcon} from 'lucide-react';
import {useId} from 'react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {summarizeActions} from '@/lib/access';
import {cn} from '@/lib/utils';

// A collection with this many actions or fewer shows its checkboxes on the page, one with a single
// action on its own row; one with more folds them under a summary.
const INLINE_ACTIONS = 2;

type Props = {
	collection: Collection;
	// The actions agents get by default.
	defaults: string[];
	// An agent's own settings. Left out on a connection's page, where the defaults themselves are set.
	own?: OwnSettings;
	// On a connection's page: how many agents have a setting of their own, by action.
	differing?: Partial<Record<string, number>>;
	// The actions listed, narrowed by a filter; every action when left out.
	shown?: string[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// Actions turned on or off; null returns an agent's action to the default.
	onChange: (actions: Record<string, boolean | null>) => void;
};

// One collection's access, the way an editor shows its settings: a checkbox per action, each the
// only control for its setting. A collection with a few actions shows them on the page; one with
// more folds them under a line saying what they add up to, such as Read & triage. On an agent's
// page every action starts on the connection's default; one the agent has its own setting for is
// marked with a bar and a Reset, and the collection's row resets all of them at once.
export function CollectionAccess({
	collection,
	defaults,
	own,
	differing,
	shown,
	open,
	onOpenChange,
	onChange,
}: Props) {
	// The same collection shows once per connection, so its checkboxes need ids of their own.
	const idPrefix = useId();
	const ids = collection.actions.map((action) => action.id);
	const isDefault = (id: string) => defaults.includes(id);
	const isOn = (id: string) => (own ? (own[id] ?? isDefault(id)) : isDefault(id));
	const isOwn = (id: string) => own?.[id] !== undefined;
	const on = ids.filter(isOn);
	const effective = on.includes('read') ? on : [];
	const changed = ids.some(isOwn);
	const inline = collection.actions.length <= INLINE_ACTIONS;
	const expanded = inline || open;
	const summary = summarizeActions(collection, effective);

	// On an agent's page, an action that matches the default follows it rather than being stored.
	const setting = (id: string, next: boolean): boolean | null => {
		if (own && next === isDefault(id)) {
			return null;
		}
		return next;
	};
	const name = (
		<>
			<span className="truncate">{collection.name}</span>
			{changed && (
				<span className="shrink-0 text-xs text-primary" title="Differs from the default">
					Changed
				</span>
			)}
		</>
	);

	const meta = (id: string) => {
		const others = differing?.[id] ?? 0;
		return (
			<span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
				{own && `Default: ${isDefault(id) ? 'on' : 'off'}`}
				{others > 0 && `Changed for ${others} ${others === 1 ? 'agent' : 'agents'}`}
				{isOwn(id) && (
					<Button size="xs" variant="ghost" onClick={() => onChange({[id]: null})}>
						Reset
					</Button>
				)}
			</span>
		);
	};

	// A collection with one action, such as Sent's Read, is that action: its checkbox sits on the
	// collection's row.
	const [only] = collection.actions;
	if (collection.actions.length === 1 && only) {
		const inputId = `${idPrefix}-${only.id}`;
		return (
			<li className="flex h-10 items-center gap-2 px-4 text-sm md:px-3">
				<Checkbox
					id={inputId}
					checked={isOn(only.id)}
					onCheckedChange={(next) => onChange({[only.id]: setting(only.id, next)})}
				/>
				<label htmlFor={inputId} className="flex min-w-0 flex-1 items-center gap-2">
					{name}
					<span className="hidden min-w-0 truncate text-xs text-muted-foreground md:inline">
						{only.label}: {only.description.toLowerCase()}
					</span>
				</label>
				{meta(only.id)}
			</li>
		);
	}

	return (
		<li>
			<div className="flex h-10 items-center gap-3 px-4 text-sm md:px-3">
				{inline ? (
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<span className="size-4 shrink-0" />
						{name}
					</div>
				) : (
					<button
						type="button"
						aria-expanded={open}
						onClick={() => onOpenChange(!open)}
						className="flex min-w-0 flex-1 items-center gap-2 text-left"
					>
						<ChevronRightIcon
							className={cn(
								'size-4 shrink-0 text-muted-foreground transition-transform',
								open && 'rotate-90',
							)}
						/>
						{name}
						<span
							className={cn(
								'ml-auto min-w-0 truncate pl-3 text-muted-foreground',
								effective.length === 0 && 'text-muted-foreground/70',
							)}
						>
							{own && !changed ? `Default: ${summary}` : summary}
						</span>
					</button>
				)}
				{changed && (
					<Button
						size="xs"
						variant="ghost"
						className="text-muted-foreground"
						onClick={() => onChange(Object.fromEntries(ids.map((id) => [id, null])))}
					>
						Reset all
					</Button>
				)}
			</div>
			{expanded && (
				<ul className="mb-2 ml-6 md:ml-5">
					{collection.actions
						.filter((action) => !shown || shown.includes(action.id))
						.map((action) => {
							const checked = isOn(action.id);
							const blocked = checked && action.id !== 'read' && !on.includes('read');
							const inputId = `${idPrefix}-${action.id}`;
							return (
								<li
									key={action.id}
									className={cn(
										'flex items-start gap-3 border-l-2 py-2 pr-4 pl-3 text-sm md:pr-3',
										isOwn(action.id) ? 'border-primary' : 'border-border',
									)}
								>
									<Checkbox
										id={inputId}
										className="mt-0.5"
										checked={checked}
										onCheckedChange={(next) => onChange({[action.id]: setting(action.id, next)})}
									/>
									<label htmlFor={inputId} className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="flex items-center gap-2">
											{action.label}
											{action.risk === 'high' && (
												<span className="text-xs text-destructive">High risk</span>
											)}
										</span>
										<span className="text-xs text-muted-foreground">
											{action.description}
											{blocked && ' · Off while Read is off'}
										</span>
									</label>
									{meta(action.id)}
								</li>
							);
						})}
				</ul>
			)}
		</li>
	);
}
