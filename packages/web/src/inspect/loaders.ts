import {redirect} from 'react-router';
import {listPersonas} from '@/client/harness-client';
import {getInspection} from '@/inspect/client';
import {unwrapLoaderResult} from '@/lib/loader-utils';
import {type OrgParams, orgOf} from '@/loaders';

// The inspector of the conversation with a persona: the first persona's where the address names none.
export async function inspectIndexLoader(args: OrgParams) {
	const org = orgOf(args);
	const {personas} = unwrapLoaderResult(await listPersonas(org));
	const first = personas[0];
	if (!first) {
		throw redirect(`/${org}`);
	}
	throw redirect(`/${org}/inspect/${first.id}`);
}

// The conversation with a persona as the harness has it, and the personas to switch between.
export async function inspectLoader(args: OrgParams & {params: {id?: string}}) {
	const org = orgOf(args);
	const [inspection, personas] = await Promise.all([
		getInspection(org, args.params.id ?? ''),
		listPersonas(org),
	]);
	return {
		inspection: unwrapLoaderResult(inspection),
		personas: unwrapLoaderResult(personas).personas,
	};
}
