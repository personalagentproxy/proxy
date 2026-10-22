import {cn} from '@proxy/ui/lib/utils';

type Logo = {
	name: string;
	src: string;
	// The tile behind the mark, and how far the mark sits in from its edges.
	tile: string;
	// An app icon with its own lighting, which `.logo-tile`'s would double.
	lit?: boolean;
	// The mark for the dark theme, where there is one.
	darkSrc?: string;
};

// The supported agents (AGENT_PROVIDERS in @proxy/integrations), ordered so the tiles' colours
// alternate. Claude Duet shares Claude's account-wide connector and login.
const AGENTS: Logo[] = [
	{name: 'ChatGPT', src: '/logos/chatgpt.png', tile: '', lit: true},
	{name: 'Claude', src: '/logos/claude.png', tile: ''},
	{name: 'Grok Bot', src: '/logos/grok-bot.png', tile: '', lit: true},
	{name: 'Claude Duet', src: '/logos/claude-duet.png', tile: ''},
	{name: 'Muse', src: '/logos/muse.png', tile: '', lit: true},
	{name: 'Poke', src: '/logos/poke.jpg', tile: '', lit: true},
	{name: 'Hermes Agent', src: '/logos/hermes.png', tile: ''},
	{name: 'Dots', src: '/logos/dot.svg', tile: 'bg-[#1B1E25] p-[24%]'},
	{name: 'Instinct', src: '/logos/instinct.png', tile: 'bg-[#F4F1EC] p-[10%]'},
];

// The services they reach through Personal Agent Proxy: Gmail (through the Email integration),
// Granola, Notion, Linear and the databases, which work now, and the ones coming next, Google
// Workspace's apps spread out among the others.
const SERVICES: Logo[] = [
	{name: 'Gmail', src: '/logos/gmail.svg', tile: 'bg-white p-[22%]'},
	{name: 'Granola', src: '/logos/granola.png', tile: 'bg-[#A4C639]'},
	{name: 'Google Calendar', src: '/logos/google-calendar.svg', tile: 'bg-white p-[22%]'},
	{name: 'Google Drive', src: '/logos/google-drive.svg', tile: 'bg-white p-[22%]'},
	{name: 'Notion', src: '/logos/notion.svg', tile: 'bg-white p-[24%]'},
	{name: 'Google Docs', src: '/logos/google-docs.svg', tile: 'bg-white p-[24%]'},
	{name: 'Google Sheets', src: '/logos/google-sheets.svg', tile: 'bg-white p-[24%]'},
	{name: 'Linear', src: '/logos/linear.svg', tile: 'bg-[#5E6AD2] p-[26%]'},
	{name: 'PostgreSQL', src: '/logos/postgresql.svg', tile: 'bg-white p-[22%]'},
	{name: 'MySQL', src: '/logos/mysql.svg', tile: 'bg-white p-[22%]'},
];

// How long one logo takes to scroll its own height and the gap after it.
const LOGO_MS = 3000;

// One tile's shape: the dock's tiles are all the same square, rounded like an app icon.
const TILE = 'size-14 shrink-0 overflow-hidden rounded-[22%] sm:size-16';

// `.logo-tile` in globals.css gives each tile its shadow and lighting.
function LogoTile({logo}: {logo: Logo}) {
	return (
		<div className={cn(TILE, 'logo-tile', logo.lit && 'logo-tile-lit', logo.tile)}>
			<img
				src={logo.src}
				alt={logo.name}
				draggable={false}
				className={cn('size-full object-contain', logo.darkSrc && 'dark:hidden')}
			/>
			{logo.darkSrc && (
				<img
					src={logo.darkSrc}
					alt={logo.name}
					draggable={false}
					className="hidden size-full object-contain dark:block"
				/>
			)}
			{!logo.lit && (
				<span aria-hidden className="logo-tile-rim">
					<span />
				</span>
			)}
		</div>
	);
}

// Scrolls its logos up, or down when `reverse`, without stopping, through a window as tall as the
// dock, so they disappear under its rounded edge; the window clips only top and bottom, so the
// tiles' shadows show at the sides. The track is the logos three times over and scrolls through
// the middle copy (`.logo-marquee` in globals.css), so there is always a logo above and below.
function LogoMarquee({logos, reverse}: {logos: Logo[]; reverse: boolean}) {
	return (
		<div className="-my-3 h-20 overflow-x-visible overflow-y-clip py-3 sm:-my-4 sm:h-24 sm:py-4">
			<div
				className="logo-marquee"
				style={{
					animationDuration: `${LOGO_MS * logos.length}ms`,
					animationDirection: reverse ? 'reverse' : 'normal',
				}}
			>
				{[0, 1, 2].map((copy) =>
					logos.map((logo) => (
						<div key={`${copy}-${logo.name}`} aria-hidden={copy !== 1} className="pb-3 sm:pb-4">
							<LogoTile logo={logo} />
						</div>
					)),
				)}
			</div>
		</div>
	);
}

// Personal Agent Proxy between the agents on its left and the services on its right, the agents
// scrolling down and the services up, like paper.design's dock. Both sides move a logo in the same
// time from the same start, so their logos line up with Personal Agent Proxy together.
export function LogoDock({className}: {className?: string}) {
	return (
		<div
			className={cn(
				'flex w-fit items-center gap-4 overflow-hidden rounded-[30px] bg-muted p-3 shadow-[0_8px_8px_-4px_#00000014,0_2px_4px_-2px_#00000014,0_1px_1px_-1px_#00000014,0_0_0_1px_#00000014] sm:gap-6 sm:rounded-[34px] sm:p-4 dark:shadow-[0_0_0_1px_#ffffff14]',
				className,
			)}
		>
			<LogoMarquee logos={AGENTS} reverse />
			<LogoTile
				logo={{
					name: 'Personal Agent Proxy',
					src: '/logos/personal-agent-proxy.svg',
					darkSrc: '/logos/personal-agent-proxy-dark.svg',
					// Padding in pixels: a percentage would be of the dock, this tile's containing block.
					tile: 'bg-white p-2 sm:p-2.5 dark:bg-black',
				}}
			/>
			<LogoMarquee logos={SERVICES} reverse={false} />
		</div>
	);
}
