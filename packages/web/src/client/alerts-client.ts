import {alertListSchema} from '@proxy/contracts/alerts';
import {apiRequest, apiSend, orgApi} from '@/client/request';

// The Alerts page's api: the person's alerts, those the agents they talk with on the Chat page set
// in their conversations, and deleting one.

export function listAlerts(org: string) {
	return apiRequest('GET', `${orgApi(org)}/alerts`, alertListSchema);
}

export function deleteAlert(org: string, alertId: string) {
	return apiSend('DELETE', `${orgApi(org)}/alerts/${alertId}`);
}
