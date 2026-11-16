import {useMemo, useState} from 'react';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {setTimeZone} from '@/client/me-client';
import {useApply} from '@/hooks/use-apply';
import {timeZones} from '@/lib/person-time-zone';

// The person's time zone, on their account: every one the browser knows, the one set chosen, saved
// as another is picked. What went wrong goes to `setError`.
export function TimeZoneSetting({
	timeZone,
	setError,
}: {
	timeZone: string | null;
	setError: (error: string | null) => void;
}) {
	const apply = useApply(setError);
	// The one picked, shown at once, before the page is loaded again with it.
	const [picked, setPicked] = useState(timeZone);
	const items = useMemo(
		() => timeZones(timeZone).map((zone) => ({value: zone, label: zone.replaceAll('_', ' ')})),
		[timeZone],
	);
	return (
		<Select
			value={picked}
			items={items}
			onValueChange={(next) => {
				if (next === null || next === picked) {
					return;
				}
				setPicked(next);
				void apply(setTimeZone(next));
			}}
		>
			<SelectTrigger aria-label="Time zone" size="sm" className="w-64">
				<SelectValue placeholder="Not set" />
			</SelectTrigger>
			<SelectContent alignItemWithTrigger={false}>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
