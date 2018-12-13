/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createConnection } from 'net';
import { Event } from 'vs/base/common/event';
import { IMessagePassingProtocol } from 'vs/base/parts/ipc/node/ipc';
import { Protocol } from 'vs/base/parts/ipc/node/ipc.net';
import product from 'vs/platform/node/product';
import { IInitData } from 'vs/workbench/api/node/extHost.protocol';
import { MessageType, createMessageOfType, isMessageOfType } from 'vs/workbench/common/extensionHostProtocol';
import { ExtensionHostMain, exit } from 'vs/workbench/node/extensionHostMain';

// With Electron 2.x and node.js 8.x the "natives" module
// can cause a native crash (see https://github.com/nodejs/node/issues/19891 and
// https://github.com/electron/electron/issues/10905). To prevent this from
// happening we essentially blocklist this module from getting loaded in any
// extension by patching the node require() function.
(function () {
	const Module = require.__$__nodeRequire('module') as any;
	const originalLoad = Module._load;

	Module._load = function (request) {
		if (request === 'natives') {
			throw new Error('Either the extension or a NPM dependency is using the "natives" node module which is unsupported as it can cause a crash of the extension host. Click [here](https://go.microsoft.com/fwlink/?linkid=871887) to find out more');
		}

		return originalLoad.apply(this, arguments);
	};
})();

interface IRendererConnection {
	protocol: IMessagePassingProtocol;
	initData: IInitData;
}

// This calls exit directly in case the initialization is not finished and we need to exit
// Otherwise, if initialization completed we go to extensionHostMain.terminate()
let onTerminate = function () {
	exit();
};

function createExtHostProtocol(pipeName: string): Promise<IMessagePassingProtocol> {

	return new Promise<IMessagePassingProtocol>((resolve, reject) => {

		const socket = createConnection(pipeName, () => {
			socket.removeListener('error', reject);
			resolve(new Protocol(socket));
		});
		socket.once('error', reject);

	}).then(protocol => {

		return new class implements IMessagePassingProtocol {

			private _terminating = false;

			readonly onMessage: Event<any> = Event.filter(protocol.onMessage, msg => {
				if (!isMessageOfType(msg, MessageType.Terminate)) {
					return true;
				}
				this._terminating = true;
				onTerminate();
				return false;
			});

			send(msg: any): void {
				if (!this._terminating) {
					protocol.send(msg);
				}
			}
		};
	});
}

function connectToRenderer(protocol: IMessagePassingProtocol): Promise<IRendererConnection> {
	return new Promise<IRendererConnection>((c, e) => {

		// Listen init data message
		const first = protocol.onMessage(raw => {
			first.dispose();

			const initData = <IInitData>JSON.parse(raw.toString());

			const rendererCommit = initData.commit;
			const myCommit = product.commit;

			if (rendererCommit && myCommit) {
				// Running in the built version where commits are defined
				if (rendererCommit !== myCommit) {
					exit(55);
				}
			}

			// Tell the outside that we are initialized
			protocol.send(createMessageOfType(MessageType.Initialized));

			c({ protocol, initData });
		});

		// Tell the outside that we are ready to receive messages
		protocol.send(createMessageOfType(MessageType.Ready));
	});
}

export async function execHostProcess(pipeName: string): Promise<ExtensionHostMain> {
	return createExtHostProtocol(pipeName).then(protocol => {
		// connect to main side
		return connectToRenderer(protocol);
	}).then(renderer => {
		// setup things
		const extensionHostMain = new ExtensionHostMain(renderer.protocol, renderer.initData);
		onTerminate = () => extensionHostMain.terminate();
		return extensionHostMain;
	});
}
