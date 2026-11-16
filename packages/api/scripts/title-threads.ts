// `bun run --cwd packages/api title-threads`: names every chat thread the small model has yet to
// name, the oldest first, through what names one as its first turn starts
// (src/harness/thread-title.ts). Run it by hand, once, after the deploy that added titles
// (migration v069_add_thread_title_written), against that server's database with its OpenRouter
// key: `DATABASE_URL` and `OPENROUTER_KEY` in the environment, or in the root .env. The threads
// from before keep a line of the message that opened them until this has run, or until their next
// turn starts; running it again names what is still unnamed.
import {disconnectDb} from '@proxy/db';

import {askForJson} from '../src/llm/open-router';
import {harnessStore} from '../src/harness/store';
import {titleThreadsWithoutTitle} from '../src/harness/thread-title';
import {env} from '../src/utils/env';

if (!env.OPENROUTER_KEY) {
	console.error('Set OPENROUTER_KEY: the titles are written by the model on it.');
	process.exit(1);
}

const titled = await titleThreadsWithoutTitle(harnessStore, {key: env.OPENROUTER_KEY, ask: askForJson}, (threadId, outcome) => {
	console.log(`${threadId}: ${outcome}`);
});
await disconnectDb();
if (titled.isErr()) {
	console.error('The threads without a title could not be read:', titled.error);
	process.exit(1);
}
const {written, skipped, failed} = titled.value;
console.log(`Written ${written}, left ${skipped}, failed ${failed}.`);
