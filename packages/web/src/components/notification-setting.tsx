import {useState} from 'react';
import {BellIcon, BellOffIcon} from 'lucide-react';
import {PillTab} from '@proxy/ui/components/pill-tab';
import {
	notificationsBlocked,
	notificationsOn,
	turnNotificationsOff,
	turnNotificationsOn,
} from '@/lib/notifications';

// Notifications of what the agents say while the person is elsewhere, on this device: one button
// for on and one for off, the one in use pressed, as the theme picker looks; where the browser has
// refused the page its leave, the way to change that is the browser's own.
export function NotificationSetting() {
	const [on, setOn] = useState(notificationsOn);
	const [blocked, setBlocked] = useState(notificationsBlocked);

	const turnOn = async () => {
		const allowed = await turnNotificationsOn();
		setOn(allowed);
		setBlocked(notificationsBlocked());
	};

	const turnOff = () => {
		turnNotificationsOff();
		setOn(false);
	};

	if (blocked) {
		return <span className="text-muted-foreground">Blocked in the browser’s settings</span>;
	}

	return (
		<div role="group" aria-label="Notifications" className="flex items-center gap-2">
			<PillTab chosen={on} aria-pressed={on} onClick={() => void turnOn()}>
				<BellIcon data-icon="inline-start" />
				On
			</PillTab>
			<PillTab chosen={!on} aria-pressed={!on} onClick={turnOff}>
				<BellOffIcon data-icon="inline-start" />
				Off
			</PillTab>
		</div>
	);
}
