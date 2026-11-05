import {useState} from 'react';
import {Button} from '@proxy/ui/components/button';
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
			<Button variant="outline" size="sm" onClick={on ? turnOff : () => void turnOn()}>
				{on ? 'Turn off' : 'Turn on'}
			</Button>
		</span>
	);
}
