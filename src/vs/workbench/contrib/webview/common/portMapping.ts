/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import * as modes from 'vs/editor/common/modes';
import { REMOTE_HOST_SCHEME } from 'vs/platform/remote/common/remoteHosts';
import { ITunnelService, RemoteTunnel, extractLocalHostUriMetaDataForPortMapping } from 'vs/platform/remote/common/tunnel';

export class WebviewPortMappingManager extends Disposable {

	private readonly _tunnels = new Map<number, Promise<RemoteTunnel>>();

	constructor(
		private readonly getExtensionLocation: () => URI | undefined,
		private readonly mappings: () => ReadonlyArray<modes.IWebviewPortMapping>,
		private readonly tunnelService: ITunnelService
	) {
		super();
	}

	public async getRedirect(url: string): Promise<string | undefined> {
		const uri = URI.parse(url);
		const requestLocalHostInfo = extractLocalHostUriMetaDataForPortMapping(uri);
		if (!requestLocalHostInfo) {
			return undefined;
		}

		for (const mapping of this.mappings()) {
			if (mapping.webviewPort === requestLocalHostInfo.port) {
				const extensionLocation = this.getExtensionLocation();
				if (extensionLocation && extensionLocation.scheme === REMOTE_HOST_SCHEME) {
					const tunnel = await this.getOrCreateTunnel(mapping.extensionHostPort);
					if (tunnel) {
						if (tunnel.tunnelLocalPort === mapping.webviewPort) {
							return undefined;
						}
						return encodeURI(uri.with({
							authority: `127.0.0.1:${tunnel.tunnelLocalPort}`,
						}).toString(true));
					}
				}

				if (mapping.webviewPort !== mapping.extensionHostPort) {
					return encodeURI(uri.with({
						authority: `${requestLocalHostInfo.address}:${mapping.extensionHostPort}`
					}).toString(true));
				}
			}
		}

		return undefined;
	}

	dispose() {
		super.dispose();

		for (const tunnel of this._tunnels.values()) {
			tunnel.then(tunnel => tunnel.dispose());
		}
		this._tunnels.clear();
	}

	private getOrCreateTunnel(remotePort: number): Promise<RemoteTunnel> | undefined {
		const existing = this._tunnels.get(remotePort);
		if (existing) {
			return existing;
		}
		const tunnel = this.tunnelService.openTunnel(undefined, remotePort);
		if (tunnel) {
			this._tunnels.set(remotePort, tunnel);
		}
		return tunnel;
	}
}
