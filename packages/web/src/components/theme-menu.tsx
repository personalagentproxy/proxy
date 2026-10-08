import {MonitorIcon, MoonIcon, SunIcon, type LucideIcon} from 'lucide-react';
import {useTheme, type Theme} from '@proxy/ui/lib/theme';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {SidebarMenuButton} from '@proxy/ui/components/sidebar';

type ThemeOption = {
	value: Theme;
	label: string;
	icon: LucideIcon;
};

const THEME_OPTIONS: Record<Theme, ThemeOption> = {
	light: {value: 'light', label: 'Light', icon: SunIcon},
	dark: {value: 'dark', label: 'Dark', icon: MoonIcon},
	system: {value: 'system', label: 'System', icon: MonitorIcon},
};

export function ThemeMenu() {
	const {theme, setTheme} = useTheme();
	const currentTheme = THEME_OPTIONS[theme];
	const CurrentThemeIcon = currentTheme.icon;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<SidebarMenuButton tooltip={`Theme: ${currentTheme.label}`} />}>
				<CurrentThemeIcon />
				<span>Theme: {currentTheme.label}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent side="right" align="end" sideOffset={8}>
				<DropdownMenuRadioGroup value={theme} aria-label="Theme">
					{Object.values(THEME_OPTIONS).map((option) => (
						<DropdownMenuRadioItem
							key={option.value}
							value={option.value}
							closeOnClick
							onClick={() => setTheme(option.value)}
						>
							<option.icon />
							{option.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
