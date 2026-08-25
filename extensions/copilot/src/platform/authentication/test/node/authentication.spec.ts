/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AuthenticationGetSessionOptions, AuthenticationSession } from 'vscode';
import { afterEach, beforeEach, expect, suite, test, vi } from 'vitest';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IConfigurationService } from '../../../configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { ICAPIClientService } from '../../../endpoint/common/capiClient';
import { IDomainService } from '../../../endpoint/common/domainService';
import { IEnvService } from '../../../env/common/envService';
import { ILogService } from '../../../log/common/logService';
import { IFetcherService } from '../../../networking/common/fetcherService';
import { ITelemetryService } from '../../../telemetry/common/telemetry';
import { createPlatformServices } from '../../../test/node/services';
import { BaseAuthenticationService, StrictAuthenticationPresentationOptions } from '../../common/authentication';
import { StaticGitHubAuthenticationService } from '../../common/staticGitHubAuthenticationService';
import { CopilotToken, createTestExtendedTokenInfo } from '../../common/copilotToken';
import { ICopilotTokenManager } from '../../common/copilotTokenManager';
import { ICopilotTokenStore } from '../../common/copilotTokenStore';
import { FixedCopilotTokenManager } from '../../node/copilotTokenManager';

/**
 * Minimal BaseAuthenticationService subclass for testing the Copilot token
 * source gating without the VS Code authentication provider plumbing.
 */
class TestableAuthenticationService extends BaseAuthenticationService {
	public setAnyGitHubSession(session: AuthenticationSession | undefined): void {
		this._anyGitHubSession = session;
	}

	override getGitHubSession(kind: 'permissive' | 'any', options: AuthenticationGetSessionOptions & { createIfNone: StrictAuthenticationPresentationOptions }): Promise<AuthenticationSession>;
	override getGitHubSession(kind: 'permissive' | 'any', options: AuthenticationGetSessionOptions & { forceNewSession: StrictAuthenticationPresentationOptions }): Promise<AuthenticationSession>;
	override getGitHubSession(kind: 'permissive' | 'any', options: Omit<AuthenticationGetSessionOptions, 'createIfNone' | 'forceNewSession'>): Promise<AuthenticationSession | undefined>;
	override getGitHubSession(_kind: 'permissive' | 'any', _options?: AuthenticationGetSessionOptions): Promise<AuthenticationSession | undefined> {
		return Promise.resolve(this._anyGitHubSession);
	}

	override getAnyAdoSession(): Promise<AuthenticationSession | undefined> {
		return Promise.resolve(undefined);
	}

	override getAdoAccessTokenBase64(): Promise<string | undefined> {
		return Promise.resolve(undefined);
	}
}

suite('AuthenticationService', function () {
	let disposables: DisposableStore;
	// These will be used to test the authentication service, but eventually these will
	// be folded into the authentication service itself.
	let copilotTokenManager: FixedCopilotTokenManager;
	let authenticationService: StaticGitHubAuthenticationService;

	const testToken = 'tid=test';

	beforeEach(async () => {
		disposables = new DisposableStore();
		const accessor = disposables.add(createPlatformServices().createTestingAccessor());
		copilotTokenManager = new FixedCopilotTokenManager(
			testToken,
			accessor.get(ILogService),
			accessor.get(ITelemetryService),
			accessor.get(ICAPIClientService),
			accessor.get(IDomainService),
			accessor.get(IFetcherService),
			accessor.get(IEnvService)
		);
		authenticationService = new StaticGitHubAuthenticationService(
			() => testToken,
			accessor.get(ILogService),
			accessor.get(ICopilotTokenStore),
			copilotTokenManager,
			accessor.get(IConfigurationService)
		);
		disposables.add(authenticationService);
	});

	afterEach(() => {
		disposables.dispose();
	});

	test('Can get anyGitHubToken', async () => {
		const token = await authenticationService.getGitHubSession('any', { silent: true });
		expect(token?.accessToken).toBe(testToken);
		expect(authenticationService.anyGitHubSession?.accessToken).toBe(testToken);
	});

	test('Can get permissiveGitHubToken', async () => {
		const token = await authenticationService.getGitHubSession('permissive', { silent: true });
		expect(token?.accessToken).toBe(testToken);
		expect(authenticationService.permissiveGitHubSession?.accessToken).toBe(testToken);
	});

	test('Can get copilotToken', async () => {
		const token = await authenticationService.getCopilotToken();
		expect(token.token).toBe(testToken);
		expect(authenticationService.copilotToken?.token).toBe(testToken);
	});

	test('hasCopilotTokenSource is true for static auth even without a GitHub session', () => {
		// Static auth represents non-OAuth Copilot token pathways (proxy/HMAC, eval harness, ...),
		// so it must report a token source regardless of whether anyGitHubSession is populated.
		const accessor = disposables.add(createPlatformServices().createTestingAccessor());
		const staticWithoutSession = disposables.add(new StaticGitHubAuthenticationService(
			undefined,
			accessor.get(ILogService),
			accessor.get(ICopilotTokenStore),
			copilotTokenManager,
			accessor.get(IConfigurationService),
		));
		expect(staticWithoutSession.anyGitHubSession).toBeUndefined();
		expect(staticWithoutSession.hasCopilotTokenSource).toBe(true);
	});

	test('NikaCode: hasCopilotTokenSource is false when GitHub integration is off even with a GitHub session', () => {
		const accessor = disposables.add(createPlatformServices().createTestingAccessor());
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		const service = disposables.add(new TestableAuthenticationService(
			accessor.get(ILogService),
			accessor.get(ICopilotTokenStore),
			copilotTokenManager,
			configService
		));
		service.setAnyGitHubSession({ id: '1', accessToken: 'token', account: { id: '1', label: 'alive2' }, scopes: [] });
		// GitHub integration off (the default): a local GitHub session must not act as a Copilot token source.
		expect(service.hasCopilotTokenSource).toBe(false);
	});

	test('NikaCode: hasCopilotTokenSource follows the GitHub session when the integration is on', async () => {
		const accessor = disposables.add(createPlatformServices().createTestingAccessor());
		const configService = accessor.get(IConfigurationService) as InMemoryConfigurationService;
		await configService.setNonExtensionConfig('nika.github.enabled', true);
		const service = disposables.add(new TestableAuthenticationService(
			accessor.get(ILogService),
			accessor.get(ICopilotTokenStore),
			copilotTokenManager,
			configService
		));
		service.setAnyGitHubSession({ id: '1', accessToken: 'token', account: { id: '1', label: 'alive2' }, scopes: [] });
		expect(service.hasCopilotTokenSource).toBe(true);
		service.setAnyGitHubSession(undefined);
		expect(service.hasCopilotTokenSource).toBe(false);
	});

	test('Emits onDidCopilotTokenChange but not onDidAuthenticationChange when a Copilot Token change is notified', async () => {
		const authChangeSpy = vi.fn();
		authenticationService.onDidAuthenticationChange(authChangeSpy);
		const promise = Event.toPromise(authenticationService.onDidCopilotTokenChange);
		const newToken = 'tid=new';
		authenticationService.setCopilotToken(new CopilotToken(createTestExtendedTokenInfo({
			token: newToken,
			username: 'fake',
			copilot_plan: 'unknown',
		})));
		await promise;
		expect(authenticationService.copilotToken?.token).toBe(newToken);
		expect(authChangeSpy).not.toHaveBeenCalled();
	});

	test.skip('Emits onDidCopilotTokenChange when a Copilot Token change is notified from the manager', async () => {
		const promise = Event.toPromise(authenticationService.onDidCopilotTokenChange);
		const newToken = 'tid=new';
		copilotTokenManager.completionsToken = newToken;
		await promise;
		expect(authenticationService.copilotToken?.token).toBe(newToken);
	});

	test('Does not emit onDidCopilotTokenChange when token errors change', async () => {
		const accessor = disposables.add(createPlatformServices().createTestingAccessor());
		const failingTokenManager = new ScriptedCopilotTokenManager([
			new Error('first failure'),
			new Error('second failure'),
		]);
		const service = disposables.add(new StaticGitHubAuthenticationService(
			() => testToken,
			accessor.get(ILogService),
			accessor.get(ICopilotTokenStore),
			failingTokenManager,
			accessor.get(IConfigurationService),
		));
		const tokenChangeSpy = vi.fn();
		service.onDidCopilotTokenChange(tokenChangeSpy);

		await expect(service.getCopilotToken()).rejects.toThrow('first failure');
		await expect(service.getCopilotToken()).rejects.toThrow('second failure');

		expect(tokenChangeSpy).not.toHaveBeenCalled();
	});

	test('Emits onDidCopilotTokenChange when a token is gained and lost', async () => {
		const accessor = disposables.add(createPlatformServices().createTestingAccessor());
		const token = new CopilotToken(createTestExtendedTokenInfo({ token: 'tid=scripted' }));
		const tokenManager = new ScriptedCopilotTokenManager([token, new Error('token lost')]);
		const service = disposables.add(new StaticGitHubAuthenticationService(
			() => testToken,
			accessor.get(ILogService),
			accessor.get(ICopilotTokenStore),
			tokenManager,
			accessor.get(IConfigurationService),
		));
		const observedTokens: Array<string | undefined> = [];
		service.onDidCopilotTokenChange(() => observedTokens.push(service.copilotToken?.token));

		await service.getCopilotToken();
		await expect(service.getCopilotToken()).rejects.toThrow('token lost');

		expect(observedTokens).toEqual(['tid=scripted', undefined]);
	});
});

class ScriptedCopilotTokenManager implements ICopilotTokenManager {
	declare readonly _serviceBrand: undefined;
	readonly onDidCopilotTokenRefresh = Event.None;

	constructor(private readonly results: Array<CopilotToken | Error>) { }

	async getCopilotToken(): Promise<CopilotToken> {
		const result = this.results.shift();
		if (!result) {
			throw new Error('No scripted token result');
		}
		if (result instanceof Error) {
			throw result;
		}
		return result;
	}

	resetCopilotToken(): void { }
}
