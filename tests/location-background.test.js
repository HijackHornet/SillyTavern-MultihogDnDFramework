import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ settings: {}, context: {}, images: {} }));
vi.mock('../state-manager.js', () => ({
    getSettings: () => host.settings,
    getEffectiveRouterCampaignPrefix: () => '',
}));
vi.mock('../memo-processor.js', () => ({}));
vi.mock('../portraits.js', () => ({
    normalizeLocationPath: path => String(path || '').trim(),
    resolveLocationImageWithMeta: path => ({ src: host.images[path] || '' }),
    applyLocationImageToChatBackground: vi.fn(),
    getLinkedPlayerCharacter: () => null,
    isLocationImageGenerating: () => false,
}));
vi.mock('../portrait-storage.js', () => ({}));
vi.mock('../router.js', () => ({
    isWorldInfoBookKnown: vi.fn(),
    scanRecentOutputForPresentNpcs: vi.fn(),
}));
vi.mock('../dungeon-reality.js', () => ({}));
vi.mock('../dungeon-map-graph.js', () => ({}));
vi.mock('../src/ui/panel/dungeon-map-panel.js', () => ({}));
vi.mock('../src/state/section-enabled.js', () => ({ isLocationMappingEnabled: () => false }));
vi.mock('../src/app/runtime-state.js', () => ({ runtimeState: {} }));

import { buildImmersionSceneState } from '../immersion.js';
import { applyLocationImageToChatBackground } from '../portraits.js';
import { isWorldInfoBookKnown, scanRecentOutputForPresentNpcs } from '../router.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function setLocation(location, chatId = 'chat') {
    host.context = { chatId, chat: [{ mes: `(Location: ${location})` }] };
}

describe('location background syncing', () => {
    it('does not apply a background while the arriving chat still has the departing projection', async () => {
        host.settings.chatLinkEnabled = true;
        host.settings.chatStateProjectionOwner = 'departing-chat';
        await buildImmersionSceneState();
        expect(applyLocationImageToChatBackground).not.toHaveBeenCalled();
    });

    it('does not apply a background when the memo changes during lorebook loading', async () => {
        host.settings.currentMemo = 'old memo';
        const lookup = deferred();
        isWorldInfoBookKnown.mockReturnValueOnce(lookup.promise);
        const pending = buildImmersionSceneState();
        host.settings.currentMemo = 'new memo';
        lookup.resolve(false);
        await pending;
        expect(applyLocationImageToChatBackground).not.toHaveBeenCalled();
    });

    beforeEach(() => {
        vi.resetAllMocks();
        host.settings = { locationImages: true, portraitAutoApplyLocationBackground: true };
        host.images = { A: 'A.png', B: 'B.png' };
        setLocation('A');
        vi.spyOn(SillyTavern, 'getContext').mockImplementation(() => host.context);
        isWorldInfoBookKnown.mockResolvedValue(false);
        scanRecentOutputForPresentNpcs.mockResolvedValue([]);
    });

    it('applies the current image when opted in', async () => {
        await buildImmersionSceneState();
        expect(applyLocationImageToChatBackground).toHaveBeenCalledExactlyOnceWith('A.png');
    });

    it.each(['portraitAutoApplyLocationBackground', 'locationImages'])('respects disabled %s', async key => {
        host.settings[key] = false;
        await buildImmersionSceneState();
        await globalThis._rpgSyncCurrentLocationBackground('A');
        expect(applyLocationImageToChatBackground).not.toHaveBeenCalled();
    });

    it('leaves the background alone when the location has no image', async () => {
        host.images = {};
        await buildImmersionSceneState();
        expect(applyLocationImageToChatBackground).not.toHaveBeenCalled();
    });

    it('does not reapply an upload scene after a newer location refresh', async () => {
        const npcs = deferred();
        const scanning = deferred();
        scanRecentOutputForPresentNpcs.mockImplementationOnce(() => {
            scanning.resolve();
            return npcs.promise;
        });
        const uploadSync = globalThis._rpgSyncCurrentLocationBackground('A');
        await scanning.promise;
        setLocation('B');
        await buildImmersionSceneState();
        npcs.resolve([]);
        await uploadSync;
        expect(applyLocationImageToChatBackground.mock.calls).toEqual([['A.png'], ['B.png']]);
    });

    it('discards an older scene whose lorebook lookup finishes last', async () => {
        const lookup = deferred();
        isWorldInfoBookKnown.mockReturnValueOnce(lookup.promise);
        const oldScene = buildImmersionSceneState();
        setLocation('B');
        await buildImmersionSceneState();
        lookup.resolve(false);
        await oldScene;
        expect(applyLocationImageToChatBackground.mock.calls).toEqual([['B.png']]);
    });

    it.each(['location', 'chat'])('discards a pending scene when the %s changes without another refresh', async change => {
        const lookup = deferred();
        isWorldInfoBookKnown.mockReturnValueOnce(lookup.promise);
        const oldScene = buildImmersionSceneState();
        setLocation(change === 'location' ? 'B' : 'A', change === 'chat' ? 'other-chat' : 'chat');
        lookup.resolve(false);
        await oldScene;
        expect(applyLocationImageToChatBackground).not.toHaveBeenCalled();
    });
});
