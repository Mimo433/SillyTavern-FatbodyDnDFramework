import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireAgentActivity } from '../src/ui/panel/panel-agent-activity.js';

afterEach(() => {
    delete globalThis.document;
});

describe('Agent activity controls', () => {
    it('wires lifecycle listeners even when optional Agent controls are absent', () => {
        const addEventListener = vi.fn();
        globalThis.document = { addEventListener };

        const activity = wireAgentActivity({
            agentPanel: { querySelector: () => null },
            getRouterTick: () => 0,
            getSettings: () => ({}),
            reapplyRouterPass: vi.fn(),
            refreshManifest: vi.fn(),
            rollbackRouterPass: vi.fn(),
            saveSettings: vi.fn(),
        });

        expect(typeof activity.syncAgentNav).toBe('function');
        expect(typeof activity.syncLastRunDisplay).toBe('function');
        expect(addEventListener).toHaveBeenCalledWith('rt_lore_agent_updated', expect.any(Function));
        expect(addEventListener).toHaveBeenCalledWith('rt_generation_tick', expect.any(Function));
    });
});
