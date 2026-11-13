import {MoonIcon, PlugIcon, SunIcon} from 'lucide-react';
import {useEffect, useRef} from 'react';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {Head} from '@/components/head';
import {EnterHint} from '@proxy/ui/components/enter-hint';
import {type Destination, KIND_NAMES, rowId} from '@/lib/command-bar';
import {resolveTheme, useTheme} from '@proxy/ui/lib/theme';
import {integrationOf} from '@/lib/integrations';

// The theme's icon: the sun in the light theme, the moon in the dark one.
function ThemeMark() {
	const {theme} = useTheme();
	const Icon = resolveTheme(theme) === 'dark' ? MoonIcon : SunIcon;
	return <Icon className="size-4 text-muted-foreground" />;
}

// An action's name, its verb in the muted colour: "Toggle theme".
function ActionLabel({label}: {label: string}) {
	const [verb, ...rest] = label.split(' ');
	return (
		<span className="truncate">
			<span className="text-muted-foreground">{verb}</span> {rest.join(' ')}
		</span>
	);
}

// What is drawn beside a destination: a page's icon, an agent's head, a connection's or an
// external agent's logo.
function Mark({mark}: {mark: Destination['mark']}) {
	if (mark.kind === 'icon') {
		return <mark.icon className="size-4 text-muted-foreground" />;
	}
	if (mark.kind === 'theme') {
		return <ThemeMark />;
	}
	if (mark.kind === 'persona') {
		return <Head look={mark.persona.look} color={mark.persona.color} size={22} />;
	}
	if (mark.kind === 'agent') {
		return <AgentLogo providerId={mark.providerId} />;
	}
	const integration = integrationOf(mark.connection);
	if (!integration) {
		return <PlugIcon className="size-4 text-muted-foreground" />;
	}
	return <IntegrationLogo integration={integration} />;
}

// Where what is typed leads, under the command bar's input: each a row with what it is, the one
// Enter opens lit, which the arrow keys in the input and the pointer move. A click opens a row.
export function CommandRows({
	rows,
	selected,
	onSelect,
	onOpen,
}: {
	rows: Destination[];
	selected: number;
	onSelect: (index: number) => void;
	onOpen: (destination: Destination) => void;
}) {
	const list = useRef<HTMLUListElement>(null);
	// The lit row is kept in view as the arrow keys move it.
	useEffect(() => {
		list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'});
	}, [selected]);

	return (
		<ul
			ref={list}
			id="command-rows"
			role="listbox"
			aria-label="Go to"
			className="flex max-h-[40vh] flex-col overflow-y-auto p-1.5 text-sm"
		>
			{rows.map((row, index) => (
				<li
					key={row.id}
					id={rowId(row)}
					role="option"
					aria-selected={index === selected}
					onPointerMove={() => onSelect(index)}
					onClick={() => onOpen(row)}
					className="flex h-9 shrink-0 cursor-default items-center gap-3 rounded-lg px-2.5 aria-selected:bg-muted"
				>
					<span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
						<Mark mark={row.mark} />
					</span>
					{row.kind === 'action' ? (
						<ActionLabel label={row.label} />
					) : (
						<span className="truncate">{row.label}</span>
					)}
					{row.detail !== null && (
						<span className="min-w-0 flex-1 truncate text-muted-foreground">{row.detail}</span>
					)}
					<span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
						{KIND_NAMES[row.kind]}
						{index === selected && <EnterHint />}
					</span>
				</li>
			))}
		</ul>
	);
}
