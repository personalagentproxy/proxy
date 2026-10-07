import type {Action, OwnSettings} from '@proxy/integrations';
import {CheckCheckIcon, Undo2Icon} from 'lucide-react';
import {useId} from 'react';
import {RowList} from '@/components/row-list';
import {IconButton} from '@/components/icon-button';
import {Badge} from '@proxy/ui/components/badge';
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
	onChange: (actions: Record<string, boolean | null>) => void;
	// On an agent's page: makes the agent's own setting for an action the connection's default.
	onMakeDefault?: (actionId: string, allowed: boolean) => void;
};

// A connection's access, the way an editor shows its settings: one checkbox per action, the only
// control for it. On an agent's page every action starts on the connection's default; one the
// agent has its own setting for is marked with a bar, a button that makes it the default for
// every agent, and one that resets it to the default.
export function ConnectionAccess({
	actions,
	defaults,
	own,
	differing,
	onChange,
	onMakeDefault,
}: Props) {
	// A connection's actions show on more than one page section, so the ids need their own prefix.
	const idPrefix = useId();
	const isDefault = (id: string) => defaults.includes(id);
	const isOn = (id: string) => (own ? (own[id] ?? isDefault(id)) : isDefault(id));
	const isOwn = (id: string) => own?.[id] !== undefined;
	// On an agent's page, an action that matches the default follows it rather than being stored.
	const setting = (id: string, next: boolean): boolean | null => {
		if (own && next === isDefault(id)) {
			return null;
		}
		return next;
	};

	return (
		<RowList>
			{actions.map((action) => {
				const checked = isOn(action.id);
				const blocked = checked && action.requires !== undefined && !isOn(action.requires);
				const required = actions.find((candidate) => candidate.id === action.requires);
				const others = differing?.[action.id] ?? 0;
				const inputId = `${idPrefix}-${action.id}`;
				return (
					<li
						key={action.id}
						className={cn(
							'flex items-start gap-3 border-l-2 py-2 pr-4 pl-3.5 text-sm md:pr-3 md:pl-2.5',
							isOwn(action.id) ? 'border-primary' : 'border-transparent',
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
									<Badge variant="destructive" className="font-normal">
										High risk
									</Badge>
								)}
							</span>
							<span className="text-muted-foreground">
								{action.description}
								{blocked && required && ` · Off while ${required.label} is off`}
							</span>
						</label>
						<span className="flex shrink-0 items-center gap-2 text-muted-foreground">
							{others > 0 && `Changed for ${others} ${others === 1 ? 'agent' : 'agents'}`}
							{isOwn(action.id) && onMakeDefault && (
								<IconButton
									label="Make this the default for every agent"
									onClick={() => onMakeDefault(action.id, checked)}
								>
									<CheckCheckIcon />
								</IconButton>
							)}
							{isOwn(action.id) && (
								<IconButton label="Reset to default" onClick={() => onChange({[action.id]: null})}>
									<Undo2Icon />
								</IconButton>
							)}
						</span>
					</li>
				);
			})}
		</RowList>
	);
}
