#!/usr/bin/env node

import {symlinkSync, mkdirSync, existsSync, lstatSync, unlinkSync, rmSync} from 'fs';
import {execSync} from 'child_process';
import {join, dirname, relative} from 'path';
import {fileURLToPath} from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

execSync('git config core.hooksPath .githooks', {cwd: root, stdio: 'inherit'});
console.log('Configured git hooks → .githooks');

const skillsSource = join(root, 'skills');

if (!existsSync(skillsSource)) {
	console.log('No skills folder found.');
	process.exit(0);
}

for (const target of ['.claude', '.codex']) {
	const targetDir = join(root, target);
	mkdirSync(targetDir, {recursive: true});

	const linkPath = join(targetDir, 'skills');
	const relativePath = relative(targetDir, skillsSource);

	try {
		const stat = lstatSync(linkPath);
		if (stat.isSymbolicLink()) {
			unlinkSync(linkPath);
		} else {
			rmSync(linkPath, {recursive: true});
		}
	} catch {
		// Doesn't exist, which is fine
	}

	symlinkSync(relativePath, linkPath);
	console.log(`Linked skills → ${target}/skills`);
}

console.log('Done.');
