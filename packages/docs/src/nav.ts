// The sidebar, in order. A page is its path under content/ without `.mdx`, and a folder's
// `index.mdx` is the folder itself (`''` is content/index.mdx). Every page is listed exactly once:
// the build fails on a file missing from here, or an entry here without a file.
export const NAV: {title: string; pages: string[]}[] = [
	{title: 'Overview', pages: ['']},
	{title: 'Self-hosting', pages: ['self-hosting/get-started']},
];
