'use client';

import {MonitorIcon, MoonIcon, SunIcon, type LucideIcon} from 'lucide-react';
import {Button} from '@proxy/ui/components/button';
import {useTheme, type Theme} from '@proxy/ui/lib/theme';

type ThemeOption = {
	value: Theme;
	label: string;
	icon: LucideIcon;
};

const SYSTEM: ThemeOption = {value: 'system', label: 'System', icon: MonitorIcon};

// In the order a click goes through them.
const THEME_OPTIONS: ThemeOption[] = [
	SYSTEM,
	{value: 'light', label: 'Light', icon: SunIcon},
	{value: 'dark', label: 'Dark', icon: MoonIcon},
];

// The web app's three themes as one footer button: it shows the current one and a click moves to
// the next.
export function ThemeToggle() {
	const {theme, setTheme} = useTheme();
	const index = THEME_OPTIONS.findIndex((option) => option.value === theme);
	const current = THEME_OPTIONS[index] ?? SYSTEM;
	const next = THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length] ?? SYSTEM;

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			className="text-muted-foreground hover:text-foreground"
			aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
			title={`Theme: ${current.label}`}
			onClick={() => setTheme(next.value)}
		>
			<current.icon />
		</Button>
	);
}
