// The ways from one screen to another that the crawl cannot see: a navigation after a button or
// a form, or a redirect from the api. Each names the screens by their route patterns, which the
// test checks against the web app's router. Keep it to what changes the screen; signing out is
// left out.
export const BUTTON_EDGES: ReadonlyArray<{from: string; to: string; label: string}> = [
	// Signing in opens the person's first organization, at its slug.
	{from: '/login', to: '/:org', label: 'Sign in'},
	{from: '/login', to: '/:org/welcome/connections', label: 'Sign in, new organization'},
	{from: '/invite/:token', to: '/:org', label: 'Join'},
	// From the switcher atop every page of an organization, Home standing for them: another
	// organization opens on its Home, the same screen, and a new one on its welcome flow.
	{from: '/:org', to: '/:org/welcome/connections', label: 'Create organization'},
	// Leaving or deleting an organization opens another of the person's.
	{from: '/:org/members', to: '/:org/connections', label: 'Leave'},
	{from: '/:org/settings', to: '/:org/connections', label: 'Delete organization'},
	// The agent lands on its tasks, to open one or start another.
	{from: '/agent/login', to: '/agent', label: 'Sign in'},
	{from: '/agent', to: '/agent/:taskId', label: 'Start task'},
	// From every page of a task, through the header; the task's home stands for them.
	{from: '/agent/:taskId', to: '/agent', label: 'Finish task'},

	{
		from: '/:org/welcome/connections',
		to: '/:org/welcome/connections/email',
		label: 'Add a mailbox',
	},
	{
		from: '/:org/welcome/connections',
		to: '/:org/welcome/connections/postgres',
		label: 'Add PostgreSQL',
	},
	{from: '/:org/welcome/connections', to: '/:org/welcome/connections/mysql', label: 'Add MySQL'},
	{
		from: '/:org/welcome/connections',
		to: '/:org/welcome/connections/mcp',
		label: 'Add a custom MCP server',
	},
	{
		from: '/:org/welcome/connections',
		to: '/:org/welcome/connections/:id',
		label: 'Sign in to Granola, Notion or Linear',
	},
	{from: '/:org/welcome/connections', to: '/:org/welcome/agent', label: 'Continue'},
	{from: '/:org/welcome/connections', to: '/:org/connections', label: 'Skip setup'},
	{from: '/:org/welcome/connections/email', to: '/:org/welcome/connections/:id', label: 'Connect'},
	{
		from: '/:org/welcome/connections/postgres',
		to: '/:org/welcome/connections/:id',
		label: 'Connect',
	},
	{from: '/:org/welcome/connections/mysql', to: '/:org/welcome/connections/:id', label: 'Connect'},
	{from: '/:org/welcome/connections/mcp', to: '/:org/welcome/connections/:id', label: 'Connect'},
	{from: '/:org/welcome/connections/:id', to: '/:org/welcome/connections', label: 'Confirm'},
	{from: '/:org/welcome/agent', to: '/:org/connections', label: 'Finish'},

	{from: '/:org/connections/new', to: '/:org/connections/new/email', label: 'Add a mailbox'},
	{from: '/:org/connections/new', to: '/:org/connections/new/postgres', label: 'Add PostgreSQL'},
	{from: '/:org/connections/new', to: '/:org/connections/new/mysql', label: 'Add MySQL'},
	{
		from: '/:org/connections/new',
		to: '/:org/connections/new/mcp',
		label: 'Add a custom MCP server',
	},
	{
		from: '/:org/connections/new',
		to: '/:org/connections/:id',
		label: 'Sign in to Granola, Notion or Linear',
	},
	{from: '/:org/connections/new/email', to: '/:org/connections/:id', label: 'Connect'},
	{from: '/:org/connections/new/postgres', to: '/:org/connections/:id', label: 'Connect'},
	{from: '/:org/connections/new/mysql', to: '/:org/connections/:id', label: 'Connect'},
	{from: '/:org/connections/new/mcp', to: '/:org/connections/:id', label: 'Connect'},
	{from: '/:org/connections/:id', to: '/:org/connections', label: 'Disconnect'},

	{from: '/:org/agents/new', to: '/:org/agents/:id', label: 'Done'},
	{from: '/:org/agents/:id/setup', to: '/:org/agents/:id', label: 'Done'},
	{from: '/:org/agents/:id', to: '/:org/agents', label: 'Delete'},

	{
		from: '/agent/:taskId/:connectionId/:collectionId/new',
		to: '/agent/:taskId/:connectionId/:collectionId/:recordId',
		label: 'Save',
	},
	{
		from: '/agent/:taskId/:connectionId/:collectionId/new',
		to: '/agent/:taskId/:connectionId/:collectionId',
		label: 'Cancel',
	},
	{
		from: '/agent/:taskId/:connectionId/:collectionId/:recordId',
		to: '/agent/:taskId/:connectionId/:collectionId',
		label: 'Delete',
	},
];
