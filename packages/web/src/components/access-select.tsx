import {
	ACCESS_LEVELS,
	minAccess,
	providerAccess,
	type Access,
	type Collection,
} from '@proxy/integrations';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import {accessLabel} from '@/lib/access';
import {cn} from '@/lib/utils';

const FOLLOW_DEFAULT = 'default';

type Props = {
	collection: Collection;
	// The stored setting; null follows the default, when there is one to follow.
	value: Access | null;
	// The connection's default, for an agent's select: offered as its first choice.
	connectionDefault?: Access;
	onChange: (next: Access | null) => void;
};

// One collection's access level. On an agent's page the first choice follows the connection's
// default, and a setting of the agent's own is marked so it stands out from the defaults.
export function AccessSelect({collection, value, connectionDefault, onChange}: Props) {
	// Levels above what the provider allows aren't offered.
	const provider = providerAccess(collection);
	const levels = ACCESS_LEVELS.filter((level) => minAccess(level, provider) === level);
	const followsDefault = connectionDefault !== undefined && value === null;
	const items = [
		...(connectionDefault === undefined
			? []
			: [
					{
						value: FOLLOW_DEFAULT,
						label: `Default (${accessLabel(collection, minAccess(connectionDefault, provider))})`,
					},
				]),
		...levels.map((level) => ({value: level, label: accessLabel(collection, level)})),
	];
	const shown = followsDefault ? FOLLOW_DEFAULT : (value ?? 'none');
	const effective = followsDefault
		? minAccess(connectionDefault, provider)
		: minAccess(value ?? 'none', provider);

	return (
		<div className="flex shrink-0 items-center gap-2">
			{connectionDefault !== undefined && value !== null && (
				<span className="text-xs text-primary" title="Differs from the connection's default">
					Changed
				</span>
			)}
			<Select
				value={shown}
				items={items}
				onValueChange={(next) => {
					if (next === FOLLOW_DEFAULT) {
						onChange(null);
						return;
					}
					const level = ACCESS_LEVELS.find((candidate) => candidate === next);
					if (level) {
						onChange(level);
					}
				}}
			>
				<SelectTrigger
					size="sm"
					aria-label={`${collection.name} access`}
					className={cn('w-52', effective === 'none' && 'text-muted-foreground')}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent align="end" alignItemWithTrigger={false}>
					{items.map((item) => (
						<SelectItem key={item.value} value={item.value}>
							{item.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
