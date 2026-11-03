import {useState} from 'react';

/**
 * A value the person can change, which goes back to the suggestion whenever the suggestion
 * changes: a widget's title follows what is typed until it is edited, and again once typing goes on.
 */
export function useSuggested<T>(suggestion: T): [T, (value: T) => void] {
	const [edited, setEdited] = useState<{suggestion: T; value: T} | null>(null);
	const value = edited && Object.is(edited.suggestion, suggestion) ? edited.value : suggestion;
	return [value, (next: T) => setEdited({suggestion, value: next})];
}
