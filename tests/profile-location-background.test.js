import { beforeEach, describe, expect, it } from 'vitest';
import { getSettings } from '../src/state/settings.js';
import { saveProfile } from '../src/state/profiles.js';
import { configureRuntimeActions } from '../src/app/runtime-bridge.js';
import { testExtensionSettings } from './setup.js';

describe('location background profile preference', () => {
    beforeEach(() => {
        for (const key of Object.keys(testExtensionSettings)) delete testExtensionSettings[key];
        configureRuntimeActions({ saveSettings: async () => {} });
    });

    it.each([true, false])('saves the %s preference for profile restoration', enabled => {
        const settings = getSettings();
        settings.portraitAutoApplyLocationBackground = enabled;
        saveProfile('background');
        expect(settings.profiles.background.portraitAutoApplyLocationBackground).toBe(enabled);
    });
});
