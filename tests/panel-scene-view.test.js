import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSceneViewController } from '../src/ui/panel/panel-scene-view.js';
import { captureDungeonMapViewport, restoreDungeonMapViewport } from '../src/ui/panel/dungeon-map-panel.js';
import { runtimeState } from '../src/app/runtime-state.js';

afterEach(() => {
    delete globalThis._rpgRefreshImmersionView;
    delete globalThis._rpgCheckRealtimeSceneArt;
    delete globalThis._rpgSyncAgentImmersionUi;
    runtimeState.hasActiveDungeonMap = false;
    runtimeState.currentChatId = null;
});

function mountController(settings, extra = {}) {
    const immersion = { style: {} };
    const manifest = { style: {} };
    const records = { classList: { toggle: () => {} }, setAttribute: () => {} };
    const visualization = { classList: { toggle: () => {} }, setAttribute: () => {} };
    const switcher = { style: {} };
    const title = { style: {} };
    const elements = new Map([
        ['#rt-agent-immersion-view', immersion],
        ['#rt-agent-manifest-list', manifest],
        ['#rt-agent-view-mode-records', records],
        ['#rt-agent-view-mode-visualization', visualization],
        ['#rt-agent-view-mode-switch', switcher],
        ['#rt-agent-campaign-header-title', title],
    ]);
    const controller = createSceneViewController({
        agentPanel: { querySelector: (selector) => elements.get(selector) || null, style: {} },
        buildImmersionSceneState: async () => ({}),
        getSettings: () => settings,
        loadLocationEntryByPath: async () => null,
        loadNpcEntryByKey: async () => null,
        maybeAutoGenerateImmersionSceneArt: () => {},
        renderImmersionViewHtml: () => '',
        runRealtimeSceneArtCheck: async () => {},
        showLocationImageSettingsMenu: async () => {},
        ...extra,
    });
    return { controller, immersion, manifest, switcher, title };
}

describe('Scene View controller', () => {
    it.each(['resolve', 'reject'])('ignores a stale scene %s after switching chats', async outcome => {
        runtimeState.currentChatId = 'A';
        let finish;
        const pending = new Promise((resolve, reject) => {
            finish = () => outcome === 'resolve' ? resolve({ dungeonMap: {} }) : reject(new Error('late failure'));
        });
        const generate = vi.fn();
        const { immersion } = mountController({ agentImmersionMode: true, locationImages: true, currentMemo: 'memo-A' }, {
            buildImmersionSceneState: () => pending,
            maybeAutoGenerateImmersionSceneArt: generate,
        });
        const refresh = runtimeState.refreshImmersionView();
        runtimeState.currentChatId = 'B';
        runtimeState.hasActiveDungeonMap = true;
        immersion.innerHTML = 'B scene';
        finish();
        await refresh;
        expect(immersion.innerHTML).toBe('B scene');
        expect(runtimeState.hasActiveDungeonMap).toBe(true);
        expect(generate).not.toHaveBeenCalled();
    });

    it('ignores a scene built against a departing memo when chat id already flipped', async () => {
        // Mirrors onChatChanged: currentChatId is set to the arriving chat before
        // loadChatState replaces the live memo. Affinity alone would pass.
        runtimeState.currentChatId = 'B';
        const settings = { agentImmersionMode: true, locationImages: true, currentMemo: 'departing-memo' };
        let finish;
        const pending = new Promise((resolve) => {
            finish = () => resolve({ dungeonMap: { rooms: 1 }, storagePath: 'Ancient Ruins' });
        });
        const generate = vi.fn();
        const { immersion } = mountController(settings, {
            buildImmersionSceneState: () => pending,
            maybeAutoGenerateImmersionSceneArt: generate,
        });
        const refresh = runtimeState.refreshImmersionView();
        // loadChatState projects the arriving partition mid-await
        settings.currentMemo = 'arriving-memo';
        immersion.innerHTML = 'arriving scene';
        finish();
        await refresh;
        expect(immersion.innerHTML).toBe('arriving scene');
        expect(generate).not.toHaveBeenCalled();
    });

    it('opens location image controls directly from the Visuals/Map hero image', () => {
        const source = readFileSync(new URL('../src/ui/panel/panel-scene-view.js', import.meta.url), 'utf8');
        const heroStart = source.indexOf("const hero = root.querySelector('.rt-immersion-hero-wrap')");
        const npcStart = source.indexOf("root.querySelectorAll('.rt-immersion-npc-tile')", heroStart);
        const heroHandler = source.slice(heroStart, npcStart);
        expect(heroHandler).toContain('await showLocationImageSettingsMenu(');
        expect(heroHandler).not.toContain('_rpgAgentOpenLocationDetail');
    });

    it('aborts Scene View refresh after a mid-await chat switch before Real-Time gen or DOM apply', () => {
        const source = readFileSync(new URL('../src/ui/panel/panel-scene-view.js', import.meta.url), 'utf8');
        const fn = source.slice(
            source.indexOf('const performImmersionRefresh = async () => {'),
            source.indexOf('runtimeState.refreshImmersionView = createCoalescedRefresh'),
        );
        expect(source).toContain("import { canCommitPassForChat } from '../../state/pass-affinity.js'");
        expect(fn).toContain('const passChatId = runtimeState.currentChatId');
        expect(fn).toContain('const memoAtStart = s.currentMemo');
        expect(fn.indexOf('await buildImmersionSceneState')).toBeGreaterThan(-1);
        expect(fn.indexOf('canCommitPassForChat(passChatId, runtimeState.currentChatId)')).toBeGreaterThan(
            fn.indexOf('await buildImmersionSceneState'),
        );
        expect(fn.indexOf("getSettings().currentMemo")).toBeGreaterThan(
            fn.indexOf('await buildImmersionSceneState'),
        );
        expect(fn.indexOf('maybeAutoGenerateImmersionSceneArt')).toBeGreaterThan(
            fn.indexOf('canCommitPassForChat(passChatId, runtimeState.currentChatId)'),
        );
    });

    it('restores a map graph viewport after the refresh replaces its scroll container', () => {
        const original = { scrollLeft: 284, scrollTop: 96 };
        const replacement = { scrollLeft: 0, scrollTop: 0 };
        const beforeRefresh = {
            querySelectorAll: () => [original],
        };
        const afterRefresh = {
            querySelectorAll: () => [replacement],
        };

        const viewport = captureDungeonMapViewport(beforeRefresh);
        restoreDungeonMapViewport(afterRefresh, viewport);

        expect(replacement.scrollLeft).toBe(284);
        expect(replacement.scrollTop).toBe(96);
    });

    it('keeps the Records view visible when location images are disabled and no map is active', () => {
        const settings = { locationImages: false, agentImmersionMode: true };
        const { controller, immersion, manifest, switcher, title } = mountController(settings);

        controller.syncAgentImmersionUi();

        expect(settings.agentImmersionMode).toBe(true);
        expect(immersion.style.display).toBe('none');
        expect(manifest.style.display).toBe('flex');
        expect(switcher.style.display).toBe('none');
        expect(title.style.display).toBe('block');
    });

    it('shows Visuals/Map when a mapped site is active even without location images', () => {
        runtimeState.hasActiveDungeonMap = true;
        const settings = { locationImages: false, agentImmersionMode: true };
        const { controller, immersion, manifest, switcher, title } = mountController(settings);

        controller.syncAgentImmersionUi();

        expect(immersion.style.display).toBe('flex');
        expect(manifest.style.display).toBe('none');
        expect(switcher.style.display).toBe('');
        expect(title.style.display).toBe('none');
    });
});
