import {useState} from 'react';
import type {AuditEntry} from '@/lib/types';
import {createTooltipHandle, type TooltipHandle} from '@proxy/ui/components/tooltip';

// What a request's target hands its chart's one tooltip (timeline-chart.tsx): the request, and the
// task it was made for, where that is one rolled into the row's.
type RequestPayload = {entry: AuditEntry; forTask: string | null};

export type RequestTooltipHandle = TooltipHandle<RequestPayload>;

/** The handle a chart's request targets share their one tooltip by. */
export function useRequestTooltip(): RequestTooltipHandle {
	const [handle] = useState(() => createTooltipHandle<RequestPayload>());
	return handle;
}
