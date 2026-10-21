import type {z} from 'zod';
import type {
	activityTaskSchema,
	agentSchema,
	auditEntrySchema,
	connectionSchema,
	dataRecordSchema,
} from '@/client/schemas';

export type Connection = z.infer<typeof connectionSchema>;
export type AgentLogin = z.infer<typeof agentSchema>;
export type DataRecord = z.infer<typeof dataRecordSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export type ActivityTask = z.infer<typeof activityTaskSchema>;
