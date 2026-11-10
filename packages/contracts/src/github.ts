import {z} from 'zod';

/**
 * What a GitHub connection reaches, for the Repositories tab of its page
 * (`GET /api/orgs/:org/connections/:connectionId/github/installations`): the accounts the app is
 * installed on that the person can see, each with what the installation covers and its
 * repositories, as GitHub decided them, and where to install the app on another account.
 */

export const githubRepositorySchema = z.object({
	/** "owner/name", as GitHub writes it, which is the repository's id in the collection too. */
	fullName: z.string(),
	visibility: z.enum(['Public', 'Private']),
	/** When it was last pushed to, where it ever was. */
	pushedAt: z.string().nullable(),
	url: z.string(),
});

export const githubInstallationSchema = z.object({
	/** The account the app is installed on: a person's login or an organization's. */
	account: z.string(),
	accountType: z.enum(['User', 'Organization']),
	/** Whether the installation covers every repository of the account, or the ones picked. */
	all: z.boolean(),
	/** Where the person changes which repositories, on GitHub. */
	settingsUrl: z.string(),
	repositories: z.array(githubRepositorySchema),
	/** Whether GitHub had more than are listed here. */
	more: z.boolean(),
});

export const githubInstallationsSchema = z.object({
	installations: z.array(githubInstallationSchema),
	/** GitHub's page for installing the app on an account, which asks which account and which repositories. */
	installUrl: z.string(),
});

export type GitHubRepository = z.infer<typeof githubRepositorySchema>;
export type GitHubInstallation = z.infer<typeof githubInstallationSchema>;
export type GitHubInstallations = z.infer<typeof githubInstallationsSchema>;
