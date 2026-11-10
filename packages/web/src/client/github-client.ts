import {githubInstallationsSchema} from '@proxy/contracts/github';
import {apiRequest, orgApi} from '@/client/request';

/** What a GitHub connection reaches: the accounts the app is installed on and their repositories. */
export function getGitHubInstallations(org: string, connectionId: string) {
	return apiRequest(
		'GET',
		`${orgApi(org)}/connections/${connectionId}/github/installations`,
		githubInstallationsSchema,
	);
}
