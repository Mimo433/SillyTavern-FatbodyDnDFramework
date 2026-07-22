import { describe, expect, it, vi } from 'vitest';
import { wireAgentWorldProgression } from '../panel-world-progression.js';

describe('World Progression panel controls', () => {
    it('exposes a status updater that reflects the current tracker setting', () => {
        const last = { textContent: '' };
        const next = { textContent: '' };
        const badge = { textContent: '', style: {}, addEventListener: vi.fn() };
        const elements = new Map([
            ['#rt-agent-world-last-fired', last],
            ['#rt-agent-world-next-fire', next],
            ['#rt-agent-world-enabled-badge', badge],
        ]);
        const settings = {
            worldProgressionEnabled: true,
            worldProgressionIntervalHours: 24,
            worldProgressionLastFiredPeriodLabel: '',
            currentMemo: '',
        };

        const controls = wireAgentWorldProgression({
            agentPanel: { querySelector: (selector) => elements.get(selector) || null },
            confirmAndPurgeWorldHistory: vi.fn(),
            extractCurrentTimeStr: () => '',
            formatInWorldTime: () => '',
            getSettings: () => settings,
            parseInWorldTime: () => null,
            saveChatState: vi.fn(),
            saveSettings: vi.fn(),
            syncCampaignPrefixAndWorldsForChat: vi.fn(),
        });

        controls.updateStatus();

        expect(last.textContent).toBe('Never');
        expect(next.textContent).toBe('—');
        expect(badge.textContent).toBe('ON');
        expect(badge.style.cssText).toContain('#34a853');
    });
});
