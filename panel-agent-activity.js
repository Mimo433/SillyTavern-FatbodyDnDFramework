import { runtimeState } from './runtime-state.js';

/** Wires Lorebook Agent history, active-key refresh, and last-run status controls. */
export function wireAgentActivity({
    agentPanel,
    getRouterTick,
    getSettings,
    reapplyRouterPass,
    refreshManifest,
    rollbackRouterPass,
    saveSettings,
}) {
    const agentNavBack = /** @type {HTMLButtonElement|null} */ (agentPanel.querySelector('#rt-agent-nav-back'));
    const agentNavFwd = /** @type {HTMLButtonElement|null} */ (agentPanel.querySelector('#rt-agent-nav-fwd'));
    const agentNavLabel = /** @type {HTMLElement|null} */ (agentPanel.querySelector('#rt-agent-nav-label'));

    const syncAgentNav = () => {
        const s = getSettings();
        const histLen = (s.routerHistory || []).length;
        const redoLen = runtimeState.loreRedoStack.length;
        if (agentNavBack) agentNavBack.disabled = histLen === 0;
        if (agentNavFwd) agentNavFwd.disabled = redoLen === 0;
        if (agentNavLabel) {
            if (redoLen === 0) {
                agentNavLabel.textContent = '[ LIVE ]';
                agentNavLabel.title = 'Lorebook is at current live state';
            } else {
                agentNavLabel.textContent = `[ -${redoLen} ]`;
                agentNavLabel.title = `Rolled back ${redoLen} agent pass${redoLen !== 1 ? 'es' : ''} — use → to redo`;
            }
            agentNavLabel.classList.remove('clickable');
        }
    };

    /** Snapshot the current lorebook state for the books touched by the given history entry. */
    const captureCurrentLoreState = async (histEntry) => {
        const ctx = SillyTavern.getContext();
        const s = getSettings();
        const bookNames = Object.keys(histEntry.bookSnapshots || {});
        const bookSnapshots = {};
        for (const name of bookNames) {
            try {
                const book = await ctx.loadWorldInfo(name);
                if (book) bookSnapshots[name] = JSON.parse(JSON.stringify(book));
            } catch (_) { }
        }
        return {
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            activeRouterKeys: JSON.parse(JSON.stringify(s.activeRouterKeys || [])),
            activeWorldKeys: JSON.parse(JSON.stringify(s.activeWorldKeys || [])),
            routerLastRunChatLength: s.routerLastRunChatLength ?? 0,
            bookSnapshots,
        };
    };

    if (agentNavBack) {
        agentNavBack.addEventListener('click', async () => {
            const s = getSettings();
            if (!(s.routerHistory || []).length) return;
            agentNavBack.disabled = true;
            if (agentNavFwd) agentNavFwd.disabled = true;
            const histEntry = s.routerHistory[0];
            const postPassState = await captureCurrentLoreState(histEntry);
            const ok = await rollbackRouterPass(0);
            if (ok) {
                runtimeState.loreRedoStack.push({ prePassSnapshot: histEntry, postPassState });
            } else {
                toastr['error']('Rollback failed. Check console.', 'Lorebook Agent');
            }
            syncAgentNav();
            await refreshManifest();
        });
    }

    if (agentNavFwd) {
        agentNavFwd.addEventListener('click', async () => {
            if (!runtimeState.loreRedoStack.length) return;
            if (agentNavBack) agentNavBack.disabled = true;
            agentNavFwd.disabled = true;
            const redoEntry = runtimeState.loreRedoStack.pop();
            const ok = await reapplyRouterPass(redoEntry.prePassSnapshot, redoEntry.postPassState);
            if (!ok) {
                runtimeState.loreRedoStack.push(redoEntry);
                toastr['error']('Redo failed. Check console.', 'Lorebook Agent');
            }
            syncAgentNav();
            await refreshManifest();
        });
    }

    // updateUndoLabel kept as alias so existing call-sites still compile
    const updateUndoLabel = syncAgentNav;
    // ── Active Keys Refresh Button & Toggle ────────────────────────────────
    const keysToggleBtn = agentPanel.querySelector('#rt-agent-keys-toggle');
    if (keysToggleBtn) {
        keysToggleBtn.addEventListener('click', (e) => {
            if (e.target.closest('#rt-agent-keys-refresh')) {
                return;
            }
            const s = getSettings();
            s.agentKeysCollapsed = !s.agentKeysCollapsed;
            localStorage.setItem('rpg_tracker_agent_keys_collapsed', String(s.agentKeysCollapsed));

            const keysContainer = agentPanel.querySelector('#rt-agent-router-active-keys');
            const chevron = agentPanel.querySelector('#rt-agent-keys-chevron');
            if (keysContainer) {
                keysContainer.style.display = s.agentKeysCollapsed ? 'none' : 'flex';
            }
            if (chevron) {
                chevron.style.transform = s.agentKeysCollapsed ? 'rotate(-90deg)' : '';
            }
        });
    }

    const keysRefreshBtn = agentPanel.querySelector('#rt-agent-keys-refresh');
    if (keysRefreshBtn) {
        keysRefreshBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            keysRefreshBtn.querySelector('i')?.classList.add('fa-spin');
            const _ctx = SillyTavern.getContext();
            if (typeof _ctx.updateWorldInfoList === 'function') {
                try { await _ctx.updateWorldInfoList(); } catch (_) { }
            }
            await runtimeState.renderRouterUI();
            keysRefreshBtn.querySelector('i')?.classList.remove('fa-spin');
        });
    }

    updateUndoLabel();

    // ── Last Run status display ────────────────────────────────────────────
    const lastRunEl = agentPanel.querySelector('#rt-agent-last-run');
    function formatLastRunRelative(epochMs) {
        if (!epochMs) return 'never';
        const sec = Math.floor((Date.now() - epochMs) / 1000);
        if (sec < 45) return 'just now';
        const min = Math.floor(sec / 60);
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        return `${Math.floor(hr / 24)}d ago`;
    }
    function syncLastRunDisplay() {
        if (!lastRunEl) return;
        const s = getSettings();
        const runEvery = s.routerRunEvery || 3;
        const tick = getRouterTick();
        const lastRunAt = s.routerLastRunAt || 0;
        const parts = [`Last run: ${formatLastRunRelative(lastRunAt)}`];
        if (runEvery > 1) {
            const nextIn = Math.max(0, runEvery - tick);
            parts.push(`Next in: ${nextIn} msg${nextIn !== 1 ? 's' : ''}`);
        }
        lastRunEl.textContent = parts.join(' · ');
    }
    syncLastRunDisplay();

    document.addEventListener('rt_lore_agent_updated', async () => {
        saveSettings();
        // Flush ST's in-memory lorebook cache before re-rendering so that
        // loadWorldInfo() picks up the entries we just wrote via the HTTP API.
        const _ctx = SillyTavern.getContext();
        if (typeof _ctx.updateWorldInfoList === 'function') {
            try { await _ctx.updateWorldInfoList(); } catch (_) { }
        }
        await runtimeState.renderRouterUI();
        if (typeof runtimeState.refreshAgentManifest === 'function') {
            await runtimeState.refreshAgentManifest();
        }
        updateUndoLabel();
        syncLastRunDisplay();
    });

    document.addEventListener('rt_generation_tick', () => {
        syncLastRunDisplay();
    });

    // ── Lorebook Terminal Logic ──

    return { syncAgentNav, syncLastRunDisplay, updateUndoLabel };
}
