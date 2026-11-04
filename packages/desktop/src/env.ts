import {app} from 'electron';

import {PRODUCTION_APP_URL} from './app-url';

// A packaged app is hosted Personal Agent Proxy's. In development, DESKTOP_APP_URL, which dev.ts
// sets from the root .env's APP_URL: the api refuses sign-ins from any other origin.
function resolveAppUrl(): string {
	if (app.isPackaged) {
		return PRODUCTION_APP_URL;
	}

	return process.env.DESKTOP_APP_URL ?? 'http://localhost:5173';
}

export const APP_URL = resolveAppUrl();
export const APP_ORIGIN = new URL(APP_URL).origin;
// build.ts puts the package's version in.
export const DESKTOP_VERSION = process.env.DESKTOP_VERSION ?? '0.0.0';
