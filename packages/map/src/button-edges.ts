// The ways from one screen to another that the crawl cannot see: a navigation after a button or
// a form, or a redirect from the api. Each names the screens by their route patterns, which the
// test checks against the web app's router. Keep it to what changes the screen; signing out is
// left out.
export const BUTTON_EDGES: ReadonlyArray<{from: string; to: string; label: string}> = [
	{from: '/login', to: '/connections', label: 'Sign in'},
	{from: '/login', to: '/welcome', label: 'Sign in, new organization'},
	{from: '/agent/login', to: '/agent', label: 'Sign in'},

	{from: '/welcome', to: '/welcome/connections', label: 'Continue'},
	{from: '/welcome/connections', to: '/welcome/connections/email', label: 'Add a mailbox'},
	{from: '/welcome/connections', to: '/welcome/connections/postgres', label: 'Add PostgreSQL'},
	{from: '/welcome/connections', to: '/welcome/connections/mysql', label: 'Add MySQL'},
	{
		from: '/welcome/connections',
		to: '/welcome/connections/:id',
		label: 'Sign in to Granola, Notion or Linear',
	},
	{from: '/welcome/connections', to: '/connections', label: 'Finish'},
	{from: '/welcome/connections/email', to: '/welcome/connections/:id', label: 'Connect'},
	{from: '/welcome/connections/postgres', to: '/welcome/connections/:id', label: 'Connect'},
	{from: '/welcome/connections/mysql', to: '/welcome/connections/:id', label: 'Connect'},
	{from: '/welcome/connections/:id', to: '/welcome/connections', label: 'Confirm'},

	{from: '/connections/new', to: '/connections/new/email', label: 'Add a mailbox'},
	{from: '/connections/new', to: '/connections/new/postgres', label: 'Add PostgreSQL'},
	{from: '/connections/new', to: '/connections/new/mysql', label: 'Add MySQL'},
	{from: '/connections/new', to: '/connections/:id', label: 'Sign in to Granola, Notion or Linear'},
	{from: '/connections/new/email', to: '/connections/:id', label: 'Connect'},
	{from: '/connections/new/postgres', to: '/connections/:id', label: 'Connect'},
	{from: '/connections/new/mysql', to: '/connections/:id', label: 'Connect'},
	{from: '/connections/:id', to: '/connections', label: 'Disconnect'},

	{from: '/agents/new', to: '/agents/:id', label: 'Done'},
	{from: '/agents/:id/setup', to: '/agents/:id', label: 'Done'},
	{from: '/agents/:id', to: '/agents', label: 'Delete'},

	{
		from: '/agent/:connectionId/:collectionId/new',
		to: '/agent/:connectionId/:collectionId/:recordId',
		label: 'Save',
	},
	{
		from: '/agent/:connectionId/:collectionId/new',
		to: '/agent/:connectionId/:collectionId',
		label: 'Cancel',
	},
	{
		from: '/agent/:connectionId/:collectionId/:recordId',
		to: '/agent/:connectionId/:collectionId',
		label: 'Delete',
	},
];
