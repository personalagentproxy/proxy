/// <reference types="bun" />
import type {GitHubInstallation} from '@proxy/contracts/github';
import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {GitHubRepositories} from '@/components/github-repositories';
import {reachedRepositories} from '@/lib/github';

afterEach(() => {
	cleanup();
});

function repository(fullName: string, visibility: 'Public' | 'Private' = 'Public') {
	return {
		fullName,
		visibility,
		pushedAt: '2026-11-01T10:00:00Z',
		url: `https://github.com/${fullName}`,
	};
}

const acme: GitHubInstallation = {
	account: 'acme',
	accountType: 'Organization',
	all: true,
	settingsUrl: 'https://github.com/organizations/acme/settings/installations/11',
	repositories: Array.from({length: 7}, (_, i) =>
		repository(`acme/repo-${i}`, i % 2 ? 'Private' : 'Public'),
	),
	more: false,
};

const alex: GitHubInstallation = {
	account: 'alexkim',
	accountType: 'User',
	all: false,
	settingsUrl: 'https://github.com/settings/installations/22',
	repositories: [repository('alexkim/notes', 'Private')],
	more: false,
};

const INSTALL = 'https://github.com/apps/personal-agent-proxy/installations/new';

describe('GitHubRepositories', () => {
	test('groups the repositories by the account the app is installed on, saying what each installation covers, with the way to change it', () => {
		render(
			<GitHubRepositories
				account="alexkim"
				shared={false}
				reach={{installations: [acme, alex], installUrl: INSTALL}}
			/>,
		);

		expect(
			screen.getByText('What your agents reach on GitHub, as the app is installed'),
		).toBeDefined();
		expect(screen.getByText('acme').parentElement?.textContent).toBe('acme · all repositories');
		expect(screen.getByText('alexkim').parentElement?.textContent).toBe(
			'alexkim · 1 of its repositories',
		);
		const manage = screen.getAllByRole('link', {name: 'Manage on GitHub'});
		expect(manage.map((link) => link.getAttribute('href'))).toEqual([
			acme.settingsUrl,
			alex.settingsUrl,
		]);
		expect(screen.getByRole('link', {name: 'Add repositories'}).getAttribute('href')).toBe(INSTALL);
		expect(reachedRepositories({installations: [acme, alex], installUrl: INSTALL})).toBe(8);
	});

	test('cuts a long group after five, the rest behind Show all', () => {
		render(
			<GitHubRepositories
				account="alexkim"
				shared={false}
				reach={{installations: [acme], installUrl: INSTALL}}
			/>,
		);

		expect(screen.queryByText('acme/repo-6')).toBeNull();
		fireEvent.click(screen.getByRole('button', {name: 'Show all 7'}));
		expect(screen.getByText('acme/repo-6')).toBeDefined();
	});

	test('says whose GitHub a shared connection reaches', () => {
		render(
			<GitHubRepositories
				account="alexkim"
				shared
				reach={{installations: [alex], installUrl: INSTALL}}
			/>,
		);

		expect(
			screen.getByText('What agents reach on GitHub as alexkim, as the app is installed'),
		).toBeDefined();
	});

	test('with the app installed nowhere, says to install it, with GitHub’s page for it', () => {
		render(
			<GitHubRepositories
				account="alexkim"
				shared={false}
				reach={{installations: [], installUrl: INSTALL}}
			/>,
		);

		expect(screen.getByText(/isn’t installed on any GitHub account/)).toBeDefined();
		expect(screen.getByRole('link', {name: 'Install on GitHub'}).getAttribute('href')).toBe(
			INSTALL,
		);
		expect(screen.queryByRole('link', {name: 'Add repositories'})).toBeNull();
	});

	test('says why GitHub could not be asked', () => {
		render(
			<GitHubRepositories
				account="alexkim"
				shared={false}
				reach={{error: 'Sign in to GitHub again.'}}
			/>,
		);

		expect(screen.getByText('Sign in to GitHub again.')).toBeDefined();
		expect(reachedRepositories({error: 'Sign in to GitHub again.'})).toBe(0);
	});
});
