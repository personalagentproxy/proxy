import {useState} from 'react';
import {PillButton} from '@proxy/ui/components/pill-button';
import {
	notificationsBlocked,
	notificationsOn,
	turnNotificationsOff,
	turnNotificationsOn,
} from '@/lib/notifications';

// Notifications of what the agents say while the person is elsewhere, on this device: on or off,
// with the button that turns them the other way; where the browser has refused the page its
// leave, the way to change that is the browser's own.
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
		<span className="flex items-center gap-3">
			<span>{on ? 'On' : 'Off'}</span>
			<PillButton variant="ghost" onClick={on ? turnOff : () => void turnOn()}>
				{on ? 'Turn off' : 'Turn on'}
			</PillButton>
		</span>
	);
}
