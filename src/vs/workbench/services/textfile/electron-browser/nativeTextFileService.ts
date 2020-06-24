/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { tmpdir } from 'os';
import { localize } from 'vs/nls';
import { AbstractTextFileService } from 'vs/workbench/services/textfile/browser/textFileService';
import { ITextFileService, ITextFileStreamContent, ITextFileContent, IResourceEncodings, IResourceEncoding, IReadTextFileOptions, IWriteTextFileOptions, stringToSnapshot, TextFileOperationResult, TextFileOperationError } from 'vs/workbench/services/textfile/common/textfiles';
import { registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { URI } from 'vs/base/common/uri';
import { IFileStatWithMetadata, ICreateFileOptions, FileOperationError, FileOperationResult, IFileStreamContent, IFileService } from 'vs/platform/files/common/files';
import { Schemas } from 'vs/base/common/network';
import { exists, stat, chmod, rimraf, MAX_FILE_SIZE, MAX_HEAP_SIZE } from 'vs/base/node/pfs';
import { join, dirname } from 'vs/base/common/path';
import { isMacintosh } from 'vs/base/common/platform';
import { IProductService } from 'vs/platform/product/common/productService';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/textResourceConfigurationService';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { UTF8, UTF8_with_bom, UTF16be, UTF16le, encodingExists, encodeStream, UTF8_BOM, toDecodeStream, IDecodeStreamResult, detectEncodingByBOMFromBuffer, isUTFEncoding } from 'vs/base/node/encoding';
import { WORKSPACE_EXTENSION } from 'vs/platform/workspaces/common/workspaces';
import { joinPath, extname, isEqualOrParent } from 'vs/base/common/resources';
import { Disposable } from 'vs/base/common/lifecycle';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { VSBufferReadable, bufferToStream } from 'vs/base/common/buffer';
import { Readable } from 'stream';
import { createTextBufferFactoryFromStream } from 'vs/editor/common/model/textModel';
import { ITextSnapshot } from 'vs/editor/common/model';
import { nodeReadableToString, streamToNodeReadable, nodeStreamToVSBufferReadable } from 'vs/base/node/stream';
import { IUntitledTextEditorService } from 'vs/workbench/services/untitled/common/untitledTextEditorService';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IDialogService, IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IFilesConfigurationService } from 'vs/workbench/services/filesConfiguration/common/filesConfigurationService';
import { ITextModelService } from 'vs/editor/common/services/resolverService';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { IPathService } from 'vs/workbench/services/path/common/pathService';
import { IWorkingCopyFileService } from 'vs/workbench/services/workingCopy/common/workingCopyFileService';
import { INativeWorkbenchEnvironmentService } from 'vs/workbench/services/environment/electron-browser/environmentService';
import { ILogService } from 'vs/platform/log/common/log';

export class NativeTextFileService extends AbstractTextFileService {

	constructor(
		@IFileService fileService: IFileService,
		@IUntitledTextEditorService untitledTextEditorService: IUntitledTextEditorService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IModelService modelService: IModelService,
		@IWorkbenchEnvironmentService protected environmentService: INativeWorkbenchEnvironmentService,
		@IDialogService dialogService: IDialogService,
		@IFileDialogService fileDialogService: IFileDialogService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IProductService private readonly productService: IProductService,
		@IFilesConfigurationService filesConfigurationService: IFilesConfigurationService,
		@ITextModelService textModelService: ITextModelService,
		@ICodeEditorService codeEditorService: ICodeEditorService,
		@IPathService pathService: IPathService,
		@IWorkingCopyFileService workingCopyFileService: IWorkingCopyFileService,
		@ILogService private readonly logService: ILogService
	) {
		super(fileService, untitledTextEditorService, lifecycleService, instantiationService, modelService, environmentService, dialogService, fileDialogService, textResourceConfigurationService, filesConfigurationService, textModelService, codeEditorService, pathService, workingCopyFileService);
	}

	private _encoding: EncodingOracle | undefined;
	get encoding(): EncodingOracle {
		if (!this._encoding) {
			this._encoding = this._register(this.instantiationService.createInstance(EncodingOracle));
		}

		return this._encoding;
	}

	async read(resource: URI, options?: IReadTextFileOptions): Promise<ITextFileContent> {
		const [bufferStream, decoder] = await this.doRead(resource, {
			...options,
			// optimization: since we know that the caller does not
			// care about buffering, we indicate this to the reader.
			// this reduces all the overhead the buffered reading
			// has (open, read, close) if the provider supports
			// unbuffered reading.
			preferUnbuffered: true
		});

		return {
			...bufferStream,
			encoding: decoder.detected.encoding || UTF8,
			value: await nodeReadableToString(decoder.stream)
		};
	}

	async readStream(resource: URI, options?: IReadTextFileOptions): Promise<ITextFileStreamContent> {
		const [bufferStream, decoder] = await this.doRead(resource, options);

		return {
			...bufferStream,
			encoding: decoder.detected.encoding || UTF8,
			value: await createTextBufferFactoryFromStream(decoder.stream)
		};
	}

	private async doRead(resource: URI, options?: IReadTextFileOptions & { preferUnbuffered?: boolean }): Promise<[IFileStreamContent, IDecodeStreamResult]> {

		// ensure limits
		options = this.ensureLimits(options);

		// read stream raw (either buffered or unbuffered)
		let bufferStream: IFileStreamContent;
		if (options.preferUnbuffered) {
			const content = await this.fileService.readFile(resource, options);
			bufferStream = {
				...content,
				value: bufferToStream(content.value)
			};
		} else {
			bufferStream = await this.fileService.readFileStream(resource, options);
		}

		// read through encoding library
		const decoder = await toDecodeStream(streamToNodeReadable(bufferStream.value), {
			guessEncoding: options?.autoGuessEncoding || this.textResourceConfigurationService.getValue(resource, 'files.autoGuessEncoding'),
			overwriteEncoding: detectedEncoding => this.encoding.getReadEncoding(resource, options, detectedEncoding)
		});

		// validate binary
		if (options?.acceptTextOnly && decoder.detected.seemsBinary) {
			throw new TextFileOperationError(localize('fileBinaryError', "File seems to be binary and cannot be opened as text"), TextFileOperationResult.FILE_IS_BINARY, options);
		}

		return [bufferStream, decoder];
	}

	private ensureLimits(options?: IReadTextFileOptions): IReadTextFileOptions {
		let ensuredOptions: IReadTextFileOptions;
		if (!options) {
			ensuredOptions = Object.create(null);
		} else {
			ensuredOptions = options;
		}

		let ensuredLimits: { size?: number; memory?: number; };
		if (!ensuredOptions.limits) {
			ensuredLimits = Object.create(null);
			ensuredOptions.limits = ensuredLimits;
		} else {
			ensuredLimits = ensuredOptions.limits;
		}

		if (typeof ensuredLimits.size !== 'number') {
			ensuredLimits.size = MAX_FILE_SIZE;
		}

		if (typeof ensuredLimits.memory !== 'number') {
			ensuredLimits.memory = Math.max(typeof this.environmentService.args['max-memory'] === 'string' ? parseInt(this.environmentService.args['max-memory']) * 1024 * 1024 || 0 : 0, MAX_HEAP_SIZE);
		}

		return ensuredOptions;
	}

	protected async doCreate(resource: URI, value?: string, options?: ICreateFileOptions): Promise<IFileStatWithMetadata> {

		// check for encoding
		const { encoding, addBOM } = await this.encoding.getWriteEncoding(resource);

		// return to parent when encoding is standard
		if (encoding === UTF8 && !addBOM) {
			return super.doCreate(resource, value, options);
		}

		// otherwise create with encoding
		return this.fileService.createFile(resource, this.getEncodedReadable(value || '', encoding, addBOM), options);
	}

	async write(resource: URI, value: string | ITextSnapshot, options?: IWriteTextFileOptions): Promise<IFileStatWithMetadata> {

		// check for overwriteReadonly property (only supported for local file://)
		try {
			if (options?.overwriteReadonly && resource.scheme === Schemas.file && await exists(resource.fsPath)) {
				const fileStat = await stat(resource.fsPath);

				// try to change mode to writeable
				await chmod(resource.fsPath, fileStat.mode | 128);
			}
		} catch (error) {
			// ignore and simply retry the operation
		}

		// check for writeElevated property (only supported for local file://)
		if (options?.writeElevated && resource.scheme === Schemas.file) {
			return this.writeElevated(resource, value, options);
		}

		try {

			// check for encoding
			const { encoding, addBOM } = await this.encoding.getWriteEncoding(resource, options);

			// return to parent when encoding is standard
			if (encoding === UTF8 && !addBOM) {
				return await super.write(resource, value, options);
			}

			// otherwise save with encoding
			else {
				return await this.fileService.writeFile(resource, this.getEncodedReadable(value, encoding, addBOM), options);
			}
		} catch (error) {

			// In case of permission denied, we need to check for readonly
			if ((<FileOperationError>error).fileOperationResult === FileOperationResult.FILE_PERMISSION_DENIED) {
				let isReadonly = false;
				try {
					const fileStat = await stat(resource.fsPath);
					if (!(fileStat.mode & 128)) {
						isReadonly = true;
					}
				} catch (error) {
					// ignore - rethrow original error
				}

				if (isReadonly) {
					throw new FileOperationError(localize('fileReadOnlyError', "File is Read Only"), FileOperationResult.FILE_READ_ONLY, options);
				}
			}

			throw error;
		}
	}

	private getEncodedReadable(value: string | ITextSnapshot, encoding: string, addBOM: boolean): VSBufferReadable {
		const readable = this.snapshotToNodeReadable(typeof value === 'string' ? stringToSnapshot(value) : value);
		const encoder = encodeStream(encoding, { addBOM });

		const encodedReadable = readable.pipe(encoder);

		return nodeStreamToVSBufferReadable(encodedReadable, addBOM && isUTFEncoding(encoding) ? { encoding } : undefined);
	}

	private snapshotToNodeReadable(snapshot: ITextSnapshot): Readable {
		return new Readable({
			read: function () {
				try {
					let chunk: string | null = null;
					let canPush = true;

					// Push all chunks as long as we can push and as long as
					// the underlying snapshot returns strings to us
					while (canPush && typeof (chunk = snapshot.read()) === 'string') {
						canPush = this.push(chunk);
					}

					// Signal EOS by pushing NULL
					if (typeof chunk !== 'string') {
						this.push(null);
					}
				} catch (error) {
					this.emit('error', error);
				}
			},
			encoding: UTF8 // very important, so that strings are passed around and not buffers!
		});
	}

	private async writeElevated(resource: URI, value: string | ITextSnapshot, options?: IWriteTextFileOptions): Promise<IFileStatWithMetadata> {

		// write into a tmp file first
		const tmpPath = join(tmpdir(), `code-elevated-${Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 6)}`);
		const { encoding, addBOM } = await this.encoding.getWriteEncoding(resource, options);
		await this.write(URI.file(tmpPath), value, { encoding: encoding === UTF8 && addBOM ? UTF8_with_bom : encoding });

		// sudo prompt copy
		await this.sudoPromptCopy(tmpPath, resource.fsPath, options);

		// clean up
		await rimraf(tmpPath);

		return this.fileService.resolve(resource, { resolveMetadata: true });
	}

	private async sudoPromptCopy(source: string, target: string, options?: IWriteTextFileOptions): Promise<void> {

		// load sudo-prompt module lazy
		const sudoPrompt = await import('sudo-prompt');

		return new Promise<void>((resolve, reject) => {
			const promptOptions = {
				name: this.productService.nameLong.replace('-', ''),
				icns: (isMacintosh && this.environmentService.isBuilt) ? join(dirname(this.environmentService.appRoot), `${this.productService.nameShort}.icns`) : undefined
			};

			const sudoCommand: string[] = [`"${this.environmentService.cliPath}"`];
			if (options?.overwriteReadonly) {
				sudoCommand.push('--file-chmod');
			}

			sudoCommand.push('--file-write', `"${source}"`, `"${target}"`);

			sudoPrompt.exec(sudoCommand.join(' '), promptOptions, (error: string, stdout: string, stderr: string) => {
				if (stdout) {
					this.logService.trace(`[sudo-prompt] received stdout: ${stdout}`);
				}

				if (stderr) {
					this.logService.trace(`[sudo-prompt] received stderr: ${stderr}`);
				}

				if (error) {
					reject(error);
				} else {
					resolve(undefined);
				}
			});
		});
	}
}

export interface IEncodingOverride {
	parent?: URI;
	extension?: string;
	encoding: string;
}

export class EncodingOracle extends Disposable implements IResourceEncodings {
	protected encodingOverrides: IEncodingOverride[];

	constructor(
		@ITextResourceConfigurationService private textResourceConfigurationService: ITextResourceConfigurationService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IFileService private fileService: IFileService
	) {
		super();

		this.encodingOverrides = this.getDefaultEncodingOverrides();

		this.registerListeners();
	}

	private registerListeners(): void {

		// Workspace Folder Change
		this._register(this.contextService.onDidChangeWorkspaceFolders(() => this.encodingOverrides = this.getDefaultEncodingOverrides()));
	}

	private getDefaultEncodingOverrides(): IEncodingOverride[] {
		const defaultEncodingOverrides: IEncodingOverride[] = [];

		// Global settings
		defaultEncodingOverrides.push({ parent: this.environmentService.userRoamingDataHome, encoding: UTF8 });

		// Workspace files (via extension and via untitled workspaces location)
		defaultEncodingOverrides.push({ extension: WORKSPACE_EXTENSION, encoding: UTF8 });
		defaultEncodingOverrides.push({ parent: this.environmentService.untitledWorkspacesHome, encoding: UTF8 });

		// Folder Settings
		this.contextService.getWorkspace().folders.forEach(folder => {
			defaultEncodingOverrides.push({ parent: joinPath(folder.uri, '.vscode'), encoding: UTF8 });
		});

		return defaultEncodingOverrides;
	}

	async getWriteEncoding(resource: URI, options?: IWriteTextFileOptions): Promise<{ encoding: string, addBOM: boolean }> {
		const { encoding, hasBOM } = this.getPreferredWriteEncoding(resource, options ? options.encoding : undefined);

		// Some encodings come with a BOM automatically
		if (hasBOM) {
			return { encoding, addBOM: true };
		}

		// Ensure that we preserve an existing BOM if found for UTF8
		// unless we are instructed to overwrite the encoding
		const overwriteEncoding = options?.overwriteEncoding;
		if (!overwriteEncoding && encoding === UTF8) {
			try {
				const buffer = (await this.fileService.readFile(resource, { length: UTF8_BOM.length })).value;
				if (detectEncodingByBOMFromBuffer(buffer, buffer.byteLength) === UTF8_with_bom) {
					return { encoding, addBOM: true };
				}
			} catch (error) {
				// ignore - file might not exist
			}
		}

		return { encoding, addBOM: false };
	}

	getPreferredWriteEncoding(resource: URI, preferredEncoding?: string): IResourceEncoding {
		const resourceEncoding = this.getEncodingForResource(resource, preferredEncoding);

		return {
			encoding: resourceEncoding,
			hasBOM: resourceEncoding === UTF16be || resourceEncoding === UTF16le || resourceEncoding === UTF8_with_bom // enforce BOM for certain encodings
		};
	}

	getReadEncoding(resource: URI, options: IReadTextFileOptions | undefined, detectedEncoding: string | null): string {
		let preferredEncoding: string | undefined;

		// Encoding passed in as option
		if (options?.encoding) {
			if (detectedEncoding === UTF8_with_bom && options.encoding === UTF8) {
				preferredEncoding = UTF8_with_bom; // indicate the file has BOM if we are to resolve with UTF 8
			} else {
				preferredEncoding = options.encoding; // give passed in encoding highest priority
			}
		}

		// Encoding detected
		else if (detectedEncoding) {
			preferredEncoding = detectedEncoding;
		}

		// Encoding configured
		else if (this.textResourceConfigurationService.getValue(resource, 'files.encoding') === UTF8_with_bom) {
			preferredEncoding = UTF8; // if we did not detect UTF 8 BOM before, this can only be UTF 8 then
		}

		return this.getEncodingForResource(resource, preferredEncoding);
	}

	private getEncodingForResource(resource: URI, preferredEncoding?: string): string {
		let fileEncoding: string;

		const override = this.getEncodingOverride(resource);
		if (override) {
			fileEncoding = override; // encoding override always wins
		} else if (preferredEncoding) {
			fileEncoding = preferredEncoding; // preferred encoding comes second
		} else {
			fileEncoding = this.textResourceConfigurationService.getValue(resource, 'files.encoding'); // and last we check for settings
		}

		if (!fileEncoding || !encodingExists(fileEncoding)) {
			fileEncoding = UTF8; // the default is UTF 8
		}

		return fileEncoding;
	}

	private getEncodingOverride(resource: URI): string | undefined {
		if (this.encodingOverrides && this.encodingOverrides.length) {
			for (const override of this.encodingOverrides) {

				// check if the resource is child of encoding override path
				if (override.parent && isEqualOrParent(resource, override.parent)) {
					return override.encoding;
				}

				// check if the resource extension is equal to encoding override
				if (override.extension && extname(resource) === `.${override.extension}`) {
					return override.encoding;
				}
			}
		}

		return undefined;
	}
}

registerSingleton(ITextFileService, NativeTextFileService);
