import {memorySchema} from '@proxy/contracts/memory';
import {apiRequest, orgApi} from '@/client/request';

// A member's memory, on its connection's page: its notes, each whole. What the person does to one
// goes through the drive's routes (files-client.ts), its notes being kept as a drive's files are.

export function getMemory(org: string, connectionId: string) {
	return apiRequest('GET', `${orgApi(org)}/connections/${connectionId}/memory`, memorySchema);
}
