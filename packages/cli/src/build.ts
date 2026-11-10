import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

import {Err, Result} from 'ts-results-es';

import {Do} from '@proxy/utils/do';

/**
 * The `pap` binary, made from main.ts with Bun's bundler: one CommonJS file, minified, that runs
 * under plain Node with nothing installed beside it, `#!/usr/bin/env node` first so it can be run
 * as `pap`. CommonJS, since Node reads a file without an extension as that. Its version is a hash
 * of the bundle, put into the bundle for `pap --version`; the api installs it in a sandbox whose
 * recorded version is another. Not part of the bundle itself: run by the api, under Bun.
 */

export type PapBundle = {code: string; version: string};

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));

// What the build writes for the version, replaced by the hash of the bundle as it is with it.
const PLACEHOLDER = 'pap-version-placeholder';

export function buildPap(): Promise<Result<PapBundle, Error>> {
	return Do(async ($) => {
		const built = $(
			await Result.wrapAsync<Bun.BuildOutput, Error>(() =>
				Bun.build({
					entrypoints: [ENTRY],
					target: 'node',
					format: 'cjs',
					minify: true,
					banner: '#!/usr/bin/env node',
					define: {PAP_VERSION: JSON.stringify(PLACEHOLDER)},
					throw: false,
				}),
			),
		);
		const [artifact] = built.outputs;
		if (!built.success || artifact === undefined) {
			return $(Err(new Error(`Building pap failed: ${built.logs.map(String).join('; ')}`)));
		}
		const text = await artifact.text();
		const version = createHash('sha256').update(text).digest('hex').slice(0, 12);
		return {code: text.replaceAll(PLACEHOLDER, version), version};
	});
}
