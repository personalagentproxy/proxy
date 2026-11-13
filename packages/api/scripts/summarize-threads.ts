// `bun run --cwd packages/api summarize-threads`: writes the one-sentence summary of every chat
// thread that has none, the oldest first, through what writes one as a thread's turn ends
// (src/harness/thread-standing.ts), leaving whether each waits for its member as it is. Run it by
// hand, once, after the deploy that added summaries (migration v065_add_thread_standing), against
// that server's database with its OpenRouter key: `DATABASE_URL` and `OPENROUTER_KEY` in the
// environment, or in the root .env. The threads from before came in done with no summary, and
// the page shows the start of their latest answer in its place until this has run. A thread at
// work is left for its turn's end to write; running it again writes what is still missing.
import {disconnectDb} from '@proxy/db';

import {askForJson} from '../src/llm/open-router';
import {harnessStore} from '../src/harness/store';
import {summarizeThreadsWithoutSummary} from '../src/harness/thread-standing';
import {env} from '../src/utils/env';

if (!env.OPENROUTER_KEY) {
	console.error('Set OPENROUTER_KEY: the summaries are written by the model on it.');
	process.exit(1);
}

const summarized = await summarizeThreadsWithoutSummary(harnessStore, {key: env.OPENROUTER_KEY, ask: askForJson}, (threadId, outcome) => {
	console.log(`${threadId}: ${outcome}`);
});
await disconnectDb();
if (summarized.isErr()) {
	console.error('The threads without a summary could not be read:', summarized.error);
	process.exit(1);
}
const {written, skipped, failed} = summarized.value;
console.log(`Written ${written}, left ${skipped}, failed ${failed}.`);
