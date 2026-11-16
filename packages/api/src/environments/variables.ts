import {z} from 'zod';

export const variablesSchema = z
	.record(
		z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		z
			.string()
			.max(65536)
			.refine((value) => !value.includes('\0')),
	)
	.refine((value) => Object.keys(value).length <= 100);
