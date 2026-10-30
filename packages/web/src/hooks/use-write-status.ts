import {useState} from 'react';
import type {WriteStatus} from '@/lib/write-status';

const IDLE: WriteStatus = {kind: 'idle'};

/**
 * A widget's write, for what is typed now: once the text changes the widget is about something
 * else, and a write that finishes after that is for text that's gone.
 */
export function useWriteStatus(typed: string): [WriteStatus, (status: WriteStatus) => void] {
	const [state, setState] = useState<{typed: string; status: WriteStatus}>({typed, status: IDLE});
	return [state.typed === typed ? state.status : IDLE, (status) => setState({typed, status})];
}
