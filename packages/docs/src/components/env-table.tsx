import {Fragment} from 'react';
import {z} from 'zod';
import {envDocs, envSchema, type EnvDoc} from '@proxy/api/env-schema';

// The `code` spans in a description, as the page's inline code.
function withCode(text: string) {
	return text.split('`').map((part, index) =>
		index % 2 === 1 ? (
			<code key={index} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.8125rem]">
				{part}
			</code>
		) : (
			<Fragment key={index}>{part}</Fragment>
		),
	);
}

function requirement(field: z.ZodType, doc: EnvDoc) {
	if (doc.required || !field.safeParse(undefined).success) {
		return <span className="font-medium">Required</span>;
	}

	if (field instanceof z.ZodDefault) {
		return withCode(`\`${String(field.def.defaultValue)}\``);
	}

	return <span className="text-muted-foreground">Optional</span>;
}

// The api's variables in one group, straight from its schema (packages/api/src/utils/env-schema.ts),
// so the table cannot drift from what the api reads.
export function EnvTable({group}: {group: EnvDoc['group']}) {
	const rows = Object.entries(envSchema.shape).flatMap(([name, field]) => {
		const doc = envDocs.get(field);
		if (!doc) {
			throw new Error(`${name} has no docs in packages/api/src/utils/env-schema.ts`);
		}
		return doc.group === group ? [{name, field, doc}] : [];
	});

	return (
		<div className="my-5 overflow-x-auto">
			<table className="w-full text-left text-sm">
				<thead>
					<tr>
						<th className="border-b py-2 pr-3 font-medium">Variable</th>
						<th className="border-b px-3 py-2 font-medium">Required / default</th>
						<th className="border-b py-2 pl-3 font-medium">Description</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(({name, field, doc}) => (
						<tr key={name}>
							<td className="border-b py-2 pr-3 align-top">
								<code className="font-mono text-[0.8125rem]">{name}</code>
							</td>
							<td className="border-b px-3 py-2 align-top whitespace-nowrap">
								{requirement(field, doc)}
							</td>
							<td className="border-b py-2 pl-3 align-top leading-6">
								{withCode(doc.description)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
