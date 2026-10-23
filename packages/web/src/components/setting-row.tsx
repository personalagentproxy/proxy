import type {ReactNode} from 'react';

// A setting on a settings page: its label, what it is, and an action beside it, as renaming.
export function SettingRow({
	label,
	action,
	children,
}: {
	label: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<li className="bleed flex h-10 min-w-0 items-center gap-3 text-sm">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{action}
		</li>
	);
}
