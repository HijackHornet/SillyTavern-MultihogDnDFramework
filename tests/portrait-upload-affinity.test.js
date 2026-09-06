import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { portraitWriteMode, snapshotPortraitMapsForChat, loadPortraitMapsForChat } from '../src/state/portrait-chat-scope.js';

// Execute the actual apply functions with controlled upload/save promises, without
// loading SillyTavern's browser-only renderer and slash-command dependencies.
function readFunction(file, name) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const match = source.match(new RegExp(`export (?:async )?function ${name}\\(`));
    if (!match) throw new Error(`Missing function ${name}`);
    return source.slice(match.index, source.indexOf('\n}', match.index) + 2).replace(/^export /, '');
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe.each([
    ['portrait', 'applyPortraitData', 'customPortraits', 'Alice'],
    ['location', 'applyLocationImageData', 'customLocationImages', 'Town :: Inn'],
])('%s upload ownership', (kind, functionName, mapKey, key) => {
    let settings, activeChat, upload, save, sync, apply, remove;
    function switchChat(id) {
        snapshotPortraitMapsForChat(settings, activeChat);
        activeChat = id;
        loadPortraitMapsForChat(settings, id);
    }

    beforeEach(() => {
        activeChat = 'A';
        settings = {
            customPortraits: {}, customLocationImages: {},
            chatStates: {
                A: { customPortraits: {}, customLocationImages: {} },
                B: { customPortraits: { Bob: 'bob.png' }, customLocationImages: { Forest: 'forest.png' } },
            },
        };
        upload = vi.fn().mockResolvedValue('new.png');
        save = vi.fn().mockResolvedValue();
        sync = vi.fn();
        remove = vi.fn().mockResolvedValue();
        const context = createContext({
            getSettings: () => settings,
            getActiveChatId: () => activeChat,
            normalizeEntityName: name => name.trim(),
            persistPortraitSrc: upload,
            portraitWriteMode,
            snapshotPortraitMapsForChat,
            isManagedPortraitPath: path => path.startsWith('managed/'),
            deletePortraitFile: remove,
            saveSettings: save,
            _rpgSyncCurrentLocationBackground: sync,
        });
        runInContext([
            readFunction('../portraits.js', 'normalizeLocationPath'),
            readFunction('../portrait-storage.js', 'countPortraitPathRefs'),
            readFunction('../portraits.js', functionName),
        ].join('\n'), context);
        apply = context[functionName];
    });

    it('writes only the original partition when the chat changes during upload', async () => {
        const gate = deferred();
        upload.mockReturnValueOnce(gate.promise);
        const pending = apply(key, 'data:image/png;base64,test');
        switchChat('B');
        const arriving = structuredClone(settings);
        gate.resolve('new.png');
        await pending;
        expect(settings[mapKey]).toEqual(arriving[mapKey]);
        expect(settings.chatStates.B).toEqual(arriving.chatStates.B);
        expect(settings.chatStates.A[mapKey][key]).toBe('new.png');
        expect(upload.mock.calls[0][1]).toBe('A');
        expect(sync).not.toHaveBeenCalled();
    });

    it('preserves a partition replaced while an explicit-owner upload is pending', async () => {
        switchChat('B');
        const gate = deferred();
        upload.mockReturnValueOnce(gate.promise);
        const pending = apply(key, 'upload', { chatId: 'A' });
        settings.chatStates.A = { currentMemo: 'new memo', [mapKey]: { Existing: 'existing.png' } };
        gate.resolve('new.png');
        await pending;
        expect(settings.chatStates.A).toEqual({ currentMemo: 'new memo', [mapKey]: { Existing: 'existing.png', [key]: 'new.png' } });
        expect(settings[mapKey][key]).toBeUndefined();
    });

    it('updates live maps if the owner becomes active during upload', async () => {
        switchChat('B');
        const gate = deferred();
        upload.mockReturnValueOnce(gate.promise);
        const pending = apply(key, 'upload', { chatId: 'A' });
        switchChat('A');
        gate.resolve('new.png');
        await pending;
        expect(settings[mapKey][key]).toBe('new.png');
        expect(settings.chatStates.A[mapKey][key]).toBe('new.png');
        if (kind === 'location') expect(sync).toHaveBeenCalledExactlyOnceWith(key);
    });

    it('leaves all maps unchanged on upload failure', async () => {
        const before = structuredClone(settings);
        upload.mockRejectedValueOnce(new Error('upload failed'));
        await expect(apply(key, 'upload')).rejects.toThrow('upload failed');
        expect(settings).toEqual(before);
        expect(save).not.toHaveBeenCalled();
    });

    it('clears only the explicit owner and keeps files referenced by another chat', async () => {
        settings[mapKey][key] = 'managed/shared.png';
        switchChat('B');
        settings[mapKey][key] = 'managed/shared.png';
        await apply(key, null, { chatId: 'A' });
        expect(settings.chatStates.A[mapKey][key]).toBeUndefined();
        expect(settings[mapKey][key]).toBe('managed/shared.png');
        expect(upload).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    });

    it('deletes an unreferenced replaced file after updating the live snapshot', async () => {
        settings[mapKey][key] = 'managed/old.png';
        snapshotPortraitMapsForChat(settings, 'A');
        await apply(key, 'upload');
        expect(settings.chatStates.A[mapKey][key]).toBe('new.png');
        expect(remove).toHaveBeenCalledExactlyOnceWith('managed/old.png');
        expect(save).toHaveBeenCalledWith(true);
    });

    it('does not refresh another chat background when switching during settings save', async () => {
        const saving = deferred();
        const gate = deferred();
        save.mockImplementationOnce(() => { saving.resolve(); return gate.promise; });
        const pending = apply(key, 'upload');
        await saving.promise;
        switchChat('B');
        gate.resolve();
        await pending;
        expect(settings.chatStates.A[mapKey][key]).toBe('new.png');
        expect(settings[mapKey][key]).toBeUndefined();
        expect(sync).not.toHaveBeenCalled();
    });
});
