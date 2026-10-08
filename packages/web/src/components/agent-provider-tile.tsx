import type {AgentProvider} from '@proxy/integrations';
import {AgentLogo} from '@/components/brand-logo';
import {cn} from '@proxy/ui/lib/utils';

// One agent to choose, in a grid of them: its logo, name and company, outlined when chosen. One
// that can't be chosen here is greyed out, its detail saying why.
export function AgentProviderTile({
	provider,
	chosen,
	disabled,
	autoFocus,
	detail,
	onChoose,
}: {
	provider: AgentProvider;
	chosen: boolean;
	disabled?: boolean;
	autoFocus?: boolean;
	detail?: string;
	onChoose: () => void;
}) {
	return (
		<button
			type="button"
			autoFocus={autoFocus}
			aria-pressed={chosen}
			disabled={disabled}
			className={cn(
				'flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50',
				chosen && 'border-foreground bg-muted/50',
				disabled && 'opacity-50 hover:bg-transparent',
			)}
			onClick={onChoose}
		>
			<AgentLogo providerId={provider.id} />
			<span className="min-w-0">
				<span className="block truncate text-sm font-medium">{provider.name}</span>
				<span className="block truncate text-xs text-muted-foreground">
					{detail ?? provider.company}
				</span>
			</span>
		</button>
	);
}
