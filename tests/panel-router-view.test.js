import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouterViewRenderer } from '../src/ui/panel/panel-router-view.js';
import { runtimeState } from '../src/app/runtime-state.js';

afterEach(() => {
    runtimeState.refreshImmersionView = async () => {};
    globalThis.SillyTavern = {
        getContext: () => ({ extensionSettings: {}, chatId: 'vitest-chat' }),
    };
});

describe('panel router view', () => {
    it('renders an empty router state and refreshes the linked World Progression fields', async () => {
        const keys = { innerHTML: '', querySelectorAll: () => [], style: {} };
        const log = { innerHTML: '', style: {} };
        const chevron = { style: {} };
        const tokens = { textContent: '' };
        const lastFired = { textContent: '' };
        const nextFire = { textContent: '' };
        const enabledBadge = { textContent: '', style: {} };
        const elements = new Map([
            ['#rt-agent-router-active-keys', keys],
            ['#rt-agent-router-log', log],
            ['#rt-agent-keys-chevron', chevron],
            ['#rt-agent-active-tokens', tokens],
            ['#rt-agent-world-last-fired', lastFired],
            ['#rt-agent-world-next-fire', nextFire],
            ['#rt-agent-world-enabled-badge', enabledBadge],
        ]);
        const settings = {
            activeRouterKeys: [],
            routerLog: [],
            worldProgressionEnabled: true,
            worldProgressionIntervalHours: 24,
            worldProgressionLastFiredPeriodLabel: '',
            currentMemo: '',
        };
        const refreshImmersionView = vi.fn().mockResolvedValue(undefined);
        runtimeState.refreshImmersionView = refreshImmersionView;
        globalThis.SillyTavern = {
            getContext: () => ({ loadWorldInfo: vi.fn() }),
        };

        const render = createRouterViewRenderer({
            agentPanel: { querySelector: (selector) => elements.get(selector) || null },
            escapeHtml: (value) => String(value),
            extractCurrentTimeStr: () => '',
            formatInWorldTime: () => '',
            getSettings: () => settings,
            parseInWorldTime: () => null,
            saveSettings: vi.fn(),
        });

        await render();

        expect(keys.innerHTML).toContain('None');
        expect(log.innerHTML).toContain('No logs yet');
        expect(tokens.textContent).toBe('(0t)');
        expect(lastFired.textContent).toBe('Never');
        expect(enabledBadge.textContent).toBe('ON');
        expect(refreshImmersionView).toHaveBeenCalledOnce();
    });
});
