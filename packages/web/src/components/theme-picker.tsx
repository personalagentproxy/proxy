import {MonitorIcon, MoonIcon, SunIcon, type LucideIcon} from 'lucide-react';
import {useTheme, type Theme} from '@proxy/ui/lib/theme';
import {Button} from '@proxy/ui/components/button';

type ThemeOption = {
	value: Theme;
	label: string;
	icon: LucideIcon;
};

const THEME_OPTIONS: ThemeOption[] = [
	{value: 'light', label: 'Light', icon: SunIcon},
	{value: 'dark', label: 'Dark', icon: MoonIcon},
	{value: 'system', label: 'System', icon: MonitorIcon},
];

// The theme, on the person's account: one button per option, the one in use pressed, as the
// toggle between what is theirs and what is shared looks.
export function ThemePicker() {
	const {theme, setTheme} = useTheme();

	return (
		<div role="group" aria-label="Theme" className="flex items-center gap-2">
			{THEME_OPTIONS.map((option) => (
				<Button
					key={option.value}
					size="sm"
					variant={option.value === theme ? 'secondary' : 'outline'}
					aria-pressed={option.value === theme}
					onClick={() => setTheme(option.value)}
				>
					<option.icon data-icon="inline-start" />
					{option.label}
				</Button>
			))}
		</div>
	);
}
