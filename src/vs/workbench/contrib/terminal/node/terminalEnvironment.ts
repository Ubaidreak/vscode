/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IProcessEnvironment, isLinux, isMacintosh, isWindows } from 'vs/base/common/platform';
import { readFile, exists } from 'vs/base/node/pfs';
import * as path from 'vs/base/common/path';
import { isString } from 'vs/base/common/types';
import { getCaseInsensitive } from 'vs/base/common/objects';

let mainProcessParentEnv: IProcessEnvironment | undefined;

export async function getMainProcessParentEnv(baseEnvironment: IProcessEnvironment = process.env as IProcessEnvironment): Promise<IProcessEnvironment> {
	if (mainProcessParentEnv) {
		return mainProcessParentEnv;
	}

	// For Linux use /proc/<pid>/status to get the parent of the main process and then fetch its
	// env using /proc/<pid>/environ.
	if (isLinux) {
		const mainProcessId = process.ppid;
		const codeProcessName = path.basename(process.argv[0]);
		let pid: number = 0;
		let ppid: number = mainProcessId;
		let name: string = codeProcessName;
		do {
			pid = ppid;
			const status = await readFile(`/proc/${pid}/status`, 'utf8');
			const splitByLine = status.split('\n');
			splitByLine.forEach(line => {
				if (line.indexOf('Name:') === 0) {
					name = line.replace(/^Name:\s+/, '');
				}
				if (line.indexOf('PPid:') === 0) {
					ppid = parseInt(line.replace(/^PPid:\s+/, ''));
				}
			});
		} while (name === codeProcessName);
		const rawEnv = await readFile(`/proc/${pid}/environ`, 'utf8');
		const env: IProcessEnvironment = {};
		rawEnv.split('\0').forEach(e => {
			const i = e.indexOf('=');
			env[e.substr(0, i)] = e.substr(i + 1);
		});
		mainProcessParentEnv = env;
	}

	// For macOS we want the "root" environment as shells by default run as login shells. It
	// doesn't appear to be possible to get the "root" environment as `ps eww -o command` for
	// PID 1 (the parent of the main process when launched from the dock/finder) returns no
	// environment, because of this we will fill in the root environment using a allowlist of
	// environment variables that we have.
	if (isMacintosh) {
		mainProcessParentEnv = {};
		// This list was generated by diffing launching a terminal with {} and the system
		// terminal launched from finder.
		const rootEnvVars = [
			'SHELL',
			'SSH_AUTH_SOCK',
			'Apple_PubSub_Socket_Render',
			'XPC_FLAGS',
			'XPC_SERVICE_NAME',
			'HOME',
			'LOGNAME',
			'TMPDIR'
		];
		rootEnvVars.forEach(k => {
			if (baseEnvironment[k]) {
				mainProcessParentEnv![k] = baseEnvironment[k]!;
			}
		});
	}

	// TODO: Windows should return a fresh environment block, might need native code?
	if (isWindows) {
		mainProcessParentEnv = baseEnvironment;
	}

	return mainProcessParentEnv!;
}

export async function findExecutable(command: string, cwd?: string, paths?: string[], env: IProcessEnvironment = process.env as IProcessEnvironment): Promise<string | undefined> {
	// If we have an absolute path then we take it.
	if (path.isAbsolute(command)) {
		return await exists(command) ? command : undefined;
	}
	if (cwd === undefined) {
		cwd = process.cwd();
	}
	const dir = path.dirname(command);
	if (dir !== '.') {
		// We have a directory and the directory is relative (see above). Make the path absolute
		// to the current working directory.
		const fullPath = path.join(cwd, command);
		return await exists(fullPath) ? fullPath : undefined;
	}
	const envPath = getCaseInsensitive(env, 'PATH');
	if (paths === undefined && isString(envPath)) {
		paths = envPath.split(path.delimiter);
	}
	// No PATH environment. Make path absolute to the cwd.
	if (paths === undefined || paths.length === 0) {
		const fullPath = path.join(cwd, command);
		return await exists(fullPath) ? fullPath : undefined;
	}
	// We have a simple file name. We get the path variable from the env
	// and try to find the executable on the path.
	for (let pathEntry of paths) {
		// The path entry is absolute.
		let fullPath: string;
		if (path.isAbsolute(pathEntry)) {
			fullPath = path.join(pathEntry, command);
		} else {
			fullPath = path.join(cwd, pathEntry, command);
		}

		if (await exists(fullPath)) {
			return fullPath;
		}
		if (isWindows) {
			let withExtension = fullPath + '.com';
			if (await exists(withExtension)) {
				return withExtension;
			}
			withExtension = fullPath + '.exe';
			if (await exists(withExtension)) {
				return withExtension;
			}
		}
	}
	const fullPath = path.join(cwd, command);
	return await exists(fullPath) ? fullPath : undefined;
}
