import {
	effectiveActions,
	presetsOf,
	sameActions,
	type Collection,
	type OwnSettings,
	type Preset,
} from '@proxy/integrations';
import {ChevronRightIcon} from 'lucide-react';
import {useId} from 'react';
import {Button} from '@/components/ui/button';
import {Checkbox} from '@/components/ui/checkbox';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import {presetLabel} from '@/lib/access';
import {cn} from '@/lib/utils';

const FOLLOW_DEFAULT = 'default';
const CUSTOM = 'custom';

type Props = {
	collection: Collection;
	// The actions agents get by default.
	defaults: string[];
	// An agent's own settings. Left out on a connection's page, where the defaults themselves are set.
	own?: OwnSettings;
	// On a connection's page: how many agents have a setting of their own, by action.
	differing?: Partial<Record<string, number>>;
	// The actions listed when open, narrowed by a filter; every action when left out.
	shown?: string[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	// Actions turned on or off; null returns an agent's action to the default.
	onChange: (actions: Record<string, boolean | null>) => void;
};

// One collection's access, the way an editor shows its settings: a preset select on the row, and
// each action on its own line beneath it once opened. On an agent's page every action starts on
// the connection's default, and one the agent has its own setting for is marked with a bar and a
// Reset, so what differs from the default stands out.
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
	const presets = presetsOf(collection);

	// On an agent's page, an action that matches the default follows it rather than being stored.
	const setting = (id: string, next: boolean): boolean | null => {
		if (own && next === isDefault(id)) {
			return null;
		}
		return next;
	};
	const applyPreset = (chosen: Preset) =>
		onChange(Object.fromEntries(ids.map((id) => [id, setting(id, chosen.actions.includes(id))])));

	const shownValue = selectValue(presets, effective, Boolean(own) && !changed);
	const items = [
		...(own
			? [
					{
						value: FOLLOW_DEFAULT,
						label: `Default (${presetLabel(collection, effectiveActions(collection, defaults))})`,
					},
				]
			: []),
		...presets.map((candidate, index) => ({value: String(index), label: candidate.label})),
		...(shownValue === CUSTOM ? [{value: CUSTOM, label: 'Custom'}] : []),
	];

	return (
		<li>
			<div className="flex h-10 items-center gap-3 px-4 text-sm md:px-3">
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
					<span className="truncate">{collection.name}</span>
					{changed && (
						<span className="shrink-0 text-xs text-primary" title="Differs from the default">
							Changed
						</span>
					)}
				</button>
				<Select
					value={shownValue}
					items={items}
					onValueChange={(next) => {
						if (next === FOLLOW_DEFAULT) {
							onChange(Object.fromEntries(ids.map((id) => [id, null])));
							return;
						}
						const chosen = presets[Number(next)];
						if (chosen) {
							applyPreset(chosen);
						}
					}}
				>
					<SelectTrigger
						size="sm"
						aria-label={`${collection.name} access`}
						className={cn('w-48', effective.length === 0 && 'text-muted-foreground')}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent align="end" alignItemWithTrigger={false}>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value} disabled={item.value === CUSTOM}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{open && (
				<ul className="mb-2 ml-6 md:ml-5">
					{collection.actions
						.filter((action) => !shown || shown.includes(action.id))
						.map((action) => {
							const checked = isOn(action.id);
							const blocked = checked && action.id !== 'read' && !on.includes('read');
							const others = differing?.[action.id] ?? 0;
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
									<span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
										{own && `Default: ${isDefault(action.id) ? 'on' : 'off'}`}
										{others > 0 && `Changed for ${others} ${others === 1 ? 'agent' : 'agents'}`}
										{isOwn(action.id) && (
											<Button
												size="xs"
												variant="ghost"
												onClick={() => onChange({[action.id]: null})}
											>
												Reset
											</Button>
										)}
									</span>
								</li>
							);
						})}
				</ul>
			)}
		</li>
	);
}

// What the select shows: Default while an agent has nothing of its own, else the preset the
// actions match, else Custom.
function selectValue(presets: Preset[], effective: string[], followsDefault: boolean): string {
	if (followsDefault) {
		return FOLLOW_DEFAULT;
	}

	const index = presets.findIndex((candidate) => sameActions(candidate.actions, effective));
	if (index === -1) {
		return CUSTOM;
	}
	return String(index);
}
