import {
	findEmails,
	findFiles,
	findPeople,
	getAgenda,
	getMailboxes,
	getRates,
} from '@/client/widgets-client';
import {lookup} from '@/lib/lookup';

// What the home page's widgets read, each kept by what it asked, so typing on doesn't ask again
// for what it already has.

export const usePeople = lookup(findPeople);

export const useAgenda = lookup((range: {from: string; to: string}) =>
	getAgenda(new Date(range.from), new Date(range.to)),
);

export const useEmails = lookup(findEmails);

export const useMailboxes = lookup((_all: true) => getMailboxes());

export const useFiles = lookup(findFiles);

export const useRates = lookup((_today: true) => getRates());
