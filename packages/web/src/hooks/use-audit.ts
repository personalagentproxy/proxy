import {useEffect, useRef} from 'react';
import {useLocation} from 'react-router';
import {useStore} from '@/components/mock-store';
import type {AuditEntry} from '@/lib/types';

type Request = Omit<AuditEntry, 'id' | 'at' | 'agentId'>;

// Logs a page's request once per address, the way the server would log the fetch behind it. The
// guard keeps a re-render, or Strict Mode running the effect twice, from logging it again.
export function useAuditOnce(request: Request | null) {
	const {log} = useStore();
	const {pathname} = useLocation();
	const logged = useRef<string | null>(null);
	// The page's address, not the record's title, so saving an edit is not a second view.
	const key = request === null ? null : `${request.action}:${pathname}`;

	useEffect(() => {
		if (request === null || key === null || logged.current === key) {
			return;
		}
		logged.current = key;
		log(request);
	});
}
