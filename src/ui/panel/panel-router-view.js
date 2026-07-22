import { runtimeState } from '../../app/runtime-state.js';

/**
 * Renders the Lorebook Agent's active-key pills, router log, and World Progression status.
 */
export function createRouterViewRenderer({
    agentPanel,
    escapeHtml,
    extractCurrentTimeStr,
    formatInWorldTime,
    getSettings,
    parseInWorldTime,
    saveSettings,
}) {
    return async function renderRouterUI() {
        const s = getSettings();
        const keysContainer = agentPanel.querySelector('#rt-agent-router-active-keys');
        const logContainer = agentPanel.querySelector('#rt-agent-router-log');
        if (!keysContainer || !logContainer) return;

        keysContainer.style.display = s.agentKeysCollapsed ? 'none' : 'flex';
        const chevron = agentPanel.querySelector('#rt-agent-keys-chevron');
        if (chevron) {
            chevron.style.transform = s.agentKeysCollapsed ? 'rotate(-90deg)' : '';
        }

        const ctx = SillyTavern.getContext();
        const books = {};
        const activeKeys = s.activeRouterKeys || [];

        // Collect needed lorebooks to minimize loads
        const neededBooks = new Set();
        for (const k of activeKeys) {
            const parts = k.split('::');
            if (parts.length > 1) neededBooks.add(parts[0]);
        }

        const bookLoads = await Promise.all([...neededBooks].map(async (bookName) => {
            try {
                return [bookName, await ctx.loadWorldInfo(bookName)];
            } catch (_) {
                return [bookName, null];
            }
        }));
        for (const [bookName, book] of bookLoads) {
            if (book) books[bookName] = book;
        }

        // Calculate total active tokens
        let activeTokens = 0;
        for (const k of activeKeys) {
            const [bookName, uid] = k.split('::');
            const entry = books[bookName]?.entries?.[uid];
            if (entry) {
                activeTokens += Math.round((entry.content || '').length / 4);
            }
        }
        const activeTokensEl = agentPanel.querySelector('#rt-agent-active-tokens');
        if (activeTokensEl) {
            activeTokensEl.textContent = `(${activeTokens}t)`;
        }

        // Use keywordActivatedKeys (persistent pool) for yellow pill coloring.
        // lastKeywordTriggeredKeys only covers the most recent scan pass and resets immediately.
        const keywordTriggeredSet = new Set(s.keywordActivatedKeys || []);

        keysContainer.innerHTML = activeKeys.map(k => {
            const [bookName, uid] = k.split('::');
            const entry = books[bookName]?.entries?.[uid];

            const shortBook = bookName.split('_').pop() || bookName;
            let label = `${shortBook}/${uid}`;
            let title = "No entry found.";
            if (entry) {
                label = entry.comment || (entry.key?.[0]) || uid;
                title = `[${bookName}] ${entry.key?.join(', ')}\n\n${(entry.content || '').substring(0, 500)}${entry.content?.length > 500 ? '...' : ''}`;
            }

            const isKeywordTriggered = keywordTriggeredSet.has(k);
            const pillBg = isKeywordTriggered ? 'rgba(58, 46, 14, 0.9)' : 'rgba(42, 42, 53, 0.8)';
            const pillBorder = isKeywordTriggered ? '1px solid rgba(210, 160, 40, 0.6)' : '1px solid rgba(255,255,255,0.1)';
            const tooltipPrefix = isKeywordTriggered ? '⌂ Keyword-triggered this turn\n\n' : '';

            return `<span class="rt-router-pill" style="background: ${pillBg}; padding: 2px 8px; border-radius: 12px; font-size: 0.769em; border: ${pillBorder}; display: inline-flex; align-items: center; gap: 6px; cursor: help; max-width: 120px;" title="${escapeHtml(tooltipPrefix + title)}">
                    ${isKeywordTriggered ? '<span style="color: #d4a028; font-size: 0.9em; flex-shrink: 0;" title="Keyword-triggered this turn">⌂</span>' : ''}
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">${escapeHtml(label)}</span>
                    <span class="rt-router-kill-key" data-key="${k}" style="cursor:pointer; color: #ff5555; font-weight: bold; padding: 0 2px;" title="Deactivate">✕</span>
                </span>`;
        }).join('') || '<span style="opacity:0.5; font-size:10px;">None</span>';

        logContainer.innerHTML = (s.routerLog || []).map(entry => {
            let diffStr = '';
            if (entry.activate?.length) diffStr += `<span style="color:#55ff55;">+${entry.activate.length}</span> `;
            if (entry.deactivate?.length) diffStr += `<span style="color:#ff5555;">-${entry.deactivate.length}</span> `;
            if (entry.record?.length) diffStr += `<span style="color:#55ccff;" title="Created: ${entry.record.join(', ')}">*${entry.record.length}</span> `;
            if (entry.delete?.length) diffStr += `<span style="color:#ff3333; font-weight: bold;" title="Deleted: ${entry.delete.join(', ')}">✕${entry.delete.length}</span> `;
            if (entry.rewrite?.length) diffStr += `<span style="color:#e67e22; font-weight: bold;" title="Rewritten: ${entry.rewrite.join(', ')}">✎${entry.rewrite.length}</span> `;
            if (entry.consolidate?.length) diffStr += `<span style="color:#9b59b6; font-weight: bold;" title="Consolidated: ${entry.consolidate.join(', ')}">⎘${entry.consolidate.length}</span> `;
            return `<div style="background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; font-size: 0.769em; margin-bottom: 4px; border-left: 2px solid rgba(255,255,255,0.05);">
                    <div style="display:flex; justify-content: space-between; opacity: 0.7; margin-bottom: 2px; font-weight: bold;">
                        <span>${entry.time}</span>
                        <span>${diffStr}</span>
                    </div>
                    <div style="line-height: 1.3;">${escapeHtml(entry.reason)}</div>
                </div>`;
        }).join('') || '<span style="opacity:0.5; font-size:10px;">No logs yet.</span>';

        // Attach kill handlers
        keysContainer.querySelectorAll('.rt-router-kill-key').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = /** @type {HTMLElement} */ (e.target);
                const key = target.getAttribute('data-key');
                const st = getSettings();
                if (st.activeRouterKeys) {
                    st.activeRouterKeys = st.activeRouterKeys.filter(k => k !== key);
                    if (st.keywordActivatedKeys) {
                        st.keywordActivatedKeys = st.keywordActivatedKeys.filter(k => k !== key);
                    }
                    if (st.lastKeywordTriggeredKeys) {
                        st.lastKeywordTriggeredKeys = st.lastKeywordTriggeredKeys.filter(k => k !== key);
                    }
                    saveSettings();
                    runtimeState.renderRouterUI();
                }
            });
        });

        // Refresh World Progression status display (reads agentPanel from outer scope)
        {
            const wpS = getSettings();
            const wpLabel = wpS.worldProgressionLastFiredPeriodLabel || '';
            const wpMins = wpLabel ? (parseInWorldTime(wpLabel) ?? -1) : -1;
            const wpIntervalMins = (wpS.worldProgressionIntervalHours || 24) * 60;
            function _fmtWP(m) {
                return formatInWorldTime(m);
            }
            const wpLastEl = agentPanel.querySelector('#rt-agent-world-last-fired');
            const wpNextEl = agentPanel.querySelector('#rt-agent-world-next-fire');
            const wpBadge = agentPanel.querySelector('#rt-agent-world-enabled-badge');
            if (wpLastEl) wpLastEl.textContent = wpLabel || 'Never';

            let wpNextMins = -1;
            if (wpMins >= 0) {
                wpNextMins = wpMins + wpIntervalMins;
            } else {
                const tMatch = (wpS.currentMemo || '').match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
                const tStr = tMatch ? extractCurrentTimeStr(tMatch[1]) : '';
                const tMins = tStr ? (parseInWorldTime(tStr) ?? -1) : -1;
                if (tMins >= 0) wpNextMins = tMins + wpIntervalMins;
            }
            if (wpNextEl) wpNextEl.textContent = wpNextMins >= 0 ? _fmtWP(wpNextMins) : '—';
            if (wpBadge) {
                wpBadge.textContent = wpS.worldProgressionEnabled ? 'ON' : 'OFF';
                wpBadge.style.cssText = wpS.worldProgressionEnabled
                    ? 'font-size:0.692em; padding:1px 7px; border-radius:10px; font-weight:bold; background:rgba(52,168,83,0.18); color:#34a853; border:1px solid rgba(52,168,83,0.3);'
                    : 'font-size:0.692em; padding:1px 7px; border-radius:10px; font-weight:bold; background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.35); border:1px solid rgba(255,255,255,0.1);';
            }
        }

        void runtimeState.refreshImmersionView().catch(() => { });
    
    };
}
