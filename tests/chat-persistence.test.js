import { describe, expect, it, beforeEach } from 'vitest';
import { getSettings, saveChatState, snapshotStockPromptsForProfile } from '../state-manager.js';
import { testExtensionSettings } from './setup.js';

describe('saveChatState', () => {
    beforeEach(() => {
        for (const key of Object.keys(testExtensionSettings)) {
            delete testExtensionSettings[key];
        }
    });

    it('snapshots stock prompts via snapshotStockPromptsForProfile without throwing', () => {
        const s = getSettings();
        s.chatLinkEnabled = true;
        s.currentMemo = 'test-memo';
        s.combatDefeatedUi = [{ name: 'Bandit', content: 'Bandit: 0/18 HP\nStatus: Defeated' }];
        s.modules = { character: true };
        s.stockPrompts = { character: 'custom prompt' };

        expect(() => saveChatState('vitest-chat', { skipDiskWrite: true })).not.toThrow();

        const part = getSettings().chatStates['vitest-chat'];
        expect(part.currentMemo).toBe('test-memo');
        expect(part.combatDefeatedUi).toEqual(s.combatDefeatedUi);
        expect(part.combatDefeatedUi).not.toBe(s.combatDefeatedUi);
        expect(part.stockPrompts.character).toBe('custom prompt');
        // merged with defaults — more keys than the one override
        expect(Object.keys(part.stockPrompts).length).toBeGreaterThan(1);
        expect(snapshotStockPromptsForProfile({ character: 'x' }).character).toBe('x');
    });

    it('keeps custom tracker definitions global while preserving legacy chat-linked modules', () => {
        const s = getSettings();
        s.customFields = [];
        delete s.customFieldsGlobalizedVersion;
        s.chatStates = {
            alpha: { customFields: [{ tag: 'ALPHA_TRACKER', label: 'Alpha', enabled: true }] },
            beta: { customFields: [{ tag: 'BETA_TRACKER', label: 'Beta', enabled: true }] },
        };

        const migrated = getSettings();
        expect(migrated.customFields.map(field => field.tag)).toEqual(['ALPHA_TRACKER', 'BETA_TRACKER']);
        expect(migrated.chatStates.alpha.customFields).toBeUndefined();
        expect(migrated.chatStates.beta.customFields).toBeUndefined();

        saveChatState('fresh-chat', { skipDiskWrite: true });
        expect(migrated.chatStates['fresh-chat'].customFields).toBeUndefined();
    });

    it('snapshots the full Control Room and tracker-module setup only when opted in', () => {
        const s = getSettings();
        s.chatSetupLinkEnabled = true;
        s.customFields = [{ tag: 'REPUTATION', label: 'Reputation', enabled: true }];
        s.customSyspromptLibrary = [{ id: 'law', tag: 'law', content: 'Custom law' }];
        s.syspromptSectionOrder = ['lib:law'];
        s.systemPromptTemplate = 'Per-chat extractor';

        saveChatState('locked-chat', { skipDiskWrite: true });

        const setup = s.chatStates['locked-chat'].setup;
        expect(setup.customFieldStates.REPUTATION).toBe(true);
        expect(setup.syspromptSnippetStates.law).toBe(false);
        expect(setup.syspromptSectionOrder).toEqual(['lib:law']);
        expect(setup.systemPromptTemplate).toBe('Per-chat extractor');
        expect(setup.cyoaConfig.slots).toBeDefined();
        expect(setup.cyoaConfig.presets).toBeDefined();
        expect(setup.cyoaConfig.buttonColor).toBeUndefined();
        expect(setup.cyoaConfig.mechBgOpacity).toBeUndefined();
        expect(s.trackerModuleDatabase[0].tag).toBe('REPUTATION');
        expect(s.syspromptSnippetDatabase[0].content).toBe('Custom law');
    });

    it('preserves phone state fields across saveChatState', () => {
        const s = getSettings();
        s.chatStates = {
            'phone-chat': {
                phoneHistory: [{ type: 'call', contact: 'Marcus', summary: 'Spoke about job' }],
                phoneContacts: [{ name: 'Marcus', relation: 'Fixer' }],
                phoneApps: [{ id: 'app1', name: 'CryptoWallet' }],
                phoneCallLog: [{ name: 'Marcus', duration: '1:30' }],
                phoneMessages: { Marcus: [{ text: 'Ready?', direction: 'in' }] },
                phoneUnread: { messages: 1, calls: 0 },
                phoneGallery: ['image_1.png'],
                phoneCache: { reddit_home: [{ name: 'r/tech' }] },
                phoneVotes: { p1: 1 },
            },
        };

        saveChatState('phone-chat', { skipDiskWrite: true });

        const part = s.chatStates['phone-chat'];
        expect(part.phoneHistory).toEqual([{ type: 'call', contact: 'Marcus', summary: 'Spoke about job' }]);
        expect(part.phoneContacts).toEqual([{ name: 'Marcus', relation: 'Fixer' }]);
        expect(part.phoneApps).toEqual([{ id: 'app1', name: 'CryptoWallet' }]);
        expect(part.phoneCallLog).toEqual([{ name: 'Marcus', duration: '1:30' }]);
        expect(part.phoneMessages.Marcus).toEqual([{ text: 'Ready?', direction: 'in' }]);
        expect(part.phoneUnread).toEqual({ messages: 1, calls: 0 });
        expect(part.phoneGallery).toEqual(['image_1.png']);
        expect(part.phoneCache.reddit_home).toEqual([{ name: 'r/tech' }]);
        expect(part.phoneVotes.p1).toBe(1);
    });
});
