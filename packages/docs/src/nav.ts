// The sidebar, in order. A page is its path under content/ without `.mdx`, and a folder's
// `index.mdx` is the folder itself (`''` is content/index.mdx). A page with `pages` has them nested
// under it, folded out while one of them is open, or always with `open`. Every page is listed
// exactly once: the build fails on a file missing from here, or an entry here without a file.
export type NavEntry = string | {page: string; pages: string[]; open?: boolean};

export const NAV: {title: string; pages: NavEntry[]}[] = [
	{title: 'Overview', pages: ['']},
	{
		title: 'Connections',
		pages: [
			'connections/information',
			{
				page: 'connections/email',
				pages: [
					'connections/email/gmail',
					'connections/email/icloud',
					'connections/email/fastmail',
					'connections/email/yahoo',
					'connections/email/other',
				],
			},
			'connections/granola',
			'connections/notion',
			'connections/linear',
			'connections/custom-integrations',
		],
	},
	{title: 'Agents', pages: ['agents/mcp']},
	{
		title: 'Self-hosting',
		pages: [
			'self-hosting',
			'self-hosting/get-started',
			'self-hosting/sign-in',
			'self-hosting/upgrades-and-backups',
			'self-hosting/telemetry',
			'self-hosting/environment',
			'self-hosting/troubleshooting',
		],
	},
];
