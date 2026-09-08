import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { canCommitPassForChat } from '../src/state/pass-affinity.js';

const source = readFileSync(new URL('../portraits.js', import.meta.url), 'utf8');
function install(context, name) {
    const match = source.match(new RegExp(`export (?:async )?function ${name}\\(`));
    if (!match) throw new Error(`Missing function ${name}`);
    runInContext(source.slice(match.index, source.indexOf('\n}', match.index) + 2).replace(/^export /, ''), context);
    return context[name];
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

describe('auto-generation lorebook affinity', () => {
    it.each(['forceCheckAutoGenerations', 'checkAndTriggerAutoGenerations', 'checkAndTriggerLocationAutoGenerations'])('%s stops after a mid-load chat switch', async name => {
        let chatId = 'A';
        const gate = deferred();
        const entered = deferred();
        const load = () => { entered.resolve(); return gate.promise; };
        const trigger = vi.fn();
        const known = new Set();
        const context = createContext({
            console: { log() {}, error() {} }, getActiveChatId: () => chatId, canCommitPassForChat,
            getSettings: () => ({ portraitAutoGenerateNpcs: true, portraitAutoGenerateLocations: true, locationImages: true }),
            SillyTavern: { getContext: () => ({ chatId, loadWorldInfo: load }) },
            getEffectiveRouterCampaignPrefix: () => 'A', getPartyMembers: () => [], getEnemyEntities: () => [],
            reconcileMemoPortraitRenames() {}, triggerPlayerPortraitAutoGenIfNeeded() {},
            knownEntities: known, isFirstCheck: true,
            loadLocationLorebookEntries: load,
            triggerBackgroundPortraitGeneration: trigger, triggerBackgroundLocationGeneration: trigger,
        });
        const run = install(context, name);
        const pending = run(() => {});
        await entered.promise;
        chatId = 'B';
        gate.resolve(name === 'checkAndTriggerLocationAutoGenerations' ? [{ label: 'Town' }] : { entries: { 0: { comment: 'Alice' } } });
        await pending;
        expect(trigger).not.toHaveBeenCalled();
        expect(known.size).toBe(0);
        expect(context.isFirstCheck).toBe(true);
    });
});

describe.each(['portrait', 'location'])('%s queue affinity', kind => {
    function harness() {
        let chatId = 'A';
        const queue = [];
        const prompt = vi.fn().mockResolvedValue('prompt');
        const image = vi.fn().mockResolvedValue('image');
        const apply = vi.fn();
        const disable = vi.fn();
        const active = new Set();
        const context = createContext({
            console: { log() {}, warn() {}, error() {} }, getActiveChatId: () => chatId, canCommitPassForChat,
            getSettings: () => ({ portraitAutoGenerateSceneView: kind === 'location' }),
            hasPortrait: () => false, hasLocationImage: () => false,
            activeGenerations: active, activeLocationGenerations: active,
            _imageGenQueue: queue, _imageGenQueueRunning: false, enqueueImageGen: job => queue.push(job),
            imageGenToast() {}, generatePortraitPrompt: prompt, generateNpcPortraitPrompt: prompt,
            generateLocationImagePrompt: prompt, generatePortraitDirect: image,
            scaleImageTo512Square: async x => x, scaleImageToLandscape: async x => x,
            applyPortraitData: apply, applyLocationImageData: apply,
            normalizeLocationPath: x => x, realtimeLocationGenerationFailed: false,
            activeRealtimeLocationAbortController: null, AbortController,
            disableRealtimeLocationGenerationAfterFailure: disable, stopRealtimeLocationGeneration() {},
        });
        const run = install(context, kind === 'portrait' ? 'triggerBackgroundPortraitGeneration' : 'triggerBackgroundLocationGeneration');
        return { queue, prompt, image, apply, disable, active,
            switchChat: () => { chatId = 'B'; },
            run: () => run('Alice', () => {}, '', { chatId: 'A', realtimeArrival: kind === 'location' }),
        };
    }
    it('rejects a stale caller pin before enqueueing', () => {
        const h = harness(); h.switchChat(); h.run();
        expect(h.queue).toHaveLength(0);
        expect(h.active.size).toBe(0);
    });
    it('does not build a prompt in another chat when the queue advances', async () => {
        const h = harness(); h.run(); h.switchChat(); await h.queue[0]();
        expect(h.prompt).not.toHaveBeenCalled();
        expect(h.active.size).toBe(0);
    });
    it('does not start image generation after switching during prompt generation', async () => {
        const h = harness(); const gate = deferred(); h.prompt.mockReturnValue(gate.promise);
        h.run(); const pending = h.queue[0](); h.switchChat(); gate.resolve('prompt'); await pending;
        expect(h.image).not.toHaveBeenCalled();
        expect(h.active.size).toBe(0);
    });
    it('still writes a completed image to the original chat', async () => {
        const h = harness(); const gate = deferred(); const entered = deferred();
        h.image.mockImplementation(() => { entered.resolve(); return gate.promise; });
        h.run(); const pending = h.queue[0](); await entered.promise; h.switchChat(); gate.resolve('image'); await pending;
        expect(h.apply).toHaveBeenCalledWith('Alice', 'image', { chatId: 'A' });
    });
    it('does not disable the arriving chat on a late image-generation failure', async () => {
        const h = harness(); const gate = deferred(); const entered = deferred();
        h.image.mockImplementation(() => { entered.resolve(); return gate.promise; });
        h.run(); const pending = h.queue[0](); await entered.promise; h.switchChat(); gate.reject(new Error('late failure')); await pending;
        expect(h.disable).not.toHaveBeenCalled();
        expect(h.apply).not.toHaveBeenCalled();
        expect(h.active.size).toBe(0);
    });
});
