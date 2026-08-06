/**
 * phone.js — Multihog D&D Framework: Modern Phone Module
 *
 * A smartphone simulation for realistic/modern genre campaigns.
 * Provides: Contacts, Dialer, Messages (SMS), Google (AI browsing),
 * Reddit (AI feed), App Store (persistent AI-generated apps), Camera
 * (image generation). NPC contacts fire probabilistically weighted
 * by relationship scores. Recent phone activity is injected into the
 * AI context only when relevant.
 *
 * Integration points:
 *  - narrative-hooks.js installInterceptor()  → buildPhoneContextBlock()
 *  - narrative-hooks.js onGenerationEnded()   → maybeFireNpcContact()
 *  - index.js                                 → bindPhone(), phone icon in panel header
 *  - character-creator.js                     → auto-enable for realistic genre
 */

import { getSettings, getActiveChatId, saveChatState, getEffectiveRouterCampaignPrefix } from './state-manager.js';
import { sendStateRequest } from './llm-client.js';
import { saveSettings } from './src/app/runtime-bridge.js';
import { cleanToolCallMessage, extractCurrentTimeStr, parseInWorldTime, formatInWorldTime } from './memo-processor.js';
import { showPortraitPromptPopup, generatePortraitDirect } from './portraits.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_PANEL_KEY        = 'rpg_phone_panel_open';
const PHONE_PANEL_GEO_KEY    = 'rpg_phone_geometry';
const PHONE_NPC_FLAG_KEY     = 'rpg_phone_npc_fired_this_turn';
const PHONE_USED_FLAG_KEY    = 'rpg_phone_used_this_turn';

/** Genre → phone skin CSS modifier class */
const GENRE_SKIN = {
    realistic : '',           // default dark glass phone
    scifi     : 'rpg-phone--scifi',
    horror    : 'rpg-phone--horror',
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime state (module-level singleton)
// ─────────────────────────────────────────────────────────────────────────────

let _phoneEl = null;          // The root phone panel DOM element
let _isOpen  = false;         // Whether the phone overlay is visible
let _phoneUsedThisTurn  = false;
let _npcFiredThisTurn   = false;

/** Current navigation stack: array of { appId, pageId, params } */
let _pageStack = [];
/** Currently rendered app id */
let _currentApp = null;

// ─────────────────────────────────────────────────────────────────────────────
// Chat-state helpers
// ─────────────────────────────────────────────────────────────────────────────

function getChatId() {
    try {
        return getActiveChatId() || SillyTavern.getContext()?.chatId || globalThis._rpgCurrentChatId?.() || '_global';
    } catch { return '_global'; }
}

function getPhoneState() {
    const s = getSettings();
    const id = getChatId();
    if (!id) return null;
    if (!s.chatStates) s.chatStates = {};
    if (!s.chatStates[id]) s.chatStates[id] = {};
    const cs = s.chatStates[id];
    if (!cs.phoneHistory)  cs.phoneHistory  = [];
    if (!cs.phoneContacts) cs.phoneContacts = [];
    if (!cs.phoneApps)     cs.phoneApps     = [];
    if (!cs.phoneCallLog)  cs.phoneCallLog  = [];
    if (!cs.phoneMessages) cs.phoneMessages = {};
    if (!cs.phoneUnread)   cs.phoneUnread   = { messages: 0, calls: 0 };
    if (!cs.phoneGallery)  cs.phoneGallery  = [];
    if (!cs.phoneCache)    cs.phoneCache    = {};  // Reddit/Google page cache
    if (!cs.phoneVotes)    cs.phoneVotes    = {};  // per-post upvote state
    return cs;
}

function savePhoneState() {
    try {
        const id = getChatId();
        if (id && id !== '_global') {
            saveChatState(id);
        }
        saveSettings();
    } catch (e) {
        console.warn('[Phone] savePhoneState failed:', e);
    }
}

/**
 * Resolves the player character's name, bio, and structured block.
 * Checks chatState playerCharacter first, then falls back to SillyTavern Persona.
 * @returns {{ pcName: string, pcBio: string, pcBlock: string }}
 */
function _getPlayerCharacterInfo() {
    const s = getSettings();
    const curChatId = getChatId();
    const stContext = SillyTavern.getContext();

    const pcState = (curChatId && s.chatStates?.[curChatId]?.playerCharacter) || null;
    const name = pcState?.name
        || stContext?.name1
        || stContext?.personas?.[stContext?.persona]?.name
        || 'Player';

    const bioParts = [];
    if (pcState?.bio) bioParts.push(pcState.bio.trim());
    const stBio = stContext?.personas?.[stContext?.persona]?.description || stContext?.persona_description;
    if (stBio && !bioParts.includes(stBio.trim())) bioParts.push(stBio.trim());

    const bio = bioParts.filter(Boolean).join('\n\n').trim();
    const block = `[PLAYER_CHARACTER]\nName: ${name}${bio ? `\n${bio}` : ''}\n[/PLAYER_CHARACTER]`;

    return { pcName: name, pcBio: bio, pcBlock: block };
}

/**
 * Resolves the active SillyTavern character card info (the card the user is chatting with).
 * Extracts world context, setting, scenario, personality, and descriptions for custom card lore.
 * @returns {{ cardName: string, cardBlock: string, cardData: any } | null}
 */
function _getActiveCardInfo() {
    try {
        const stContext = SillyTavern.getContext?.() || {};
        const charId = stContext.characterId ?? stContext.this_chid;
        let charData = (charId != null && stContext.characters) ? stContext.characters[charId] : null;

        if (!charData && stContext.characters && stContext.name2) {
            const n2 = String(stContext.name2).toLowerCase().trim();
            charData = Object.values(stContext.characters).find(c => c && String(c.name || '').toLowerCase().trim() === n2) || null;
        }

        if (!charData && !stContext.name2) return null;

        const name = charData?.name || stContext.name2 || 'Active Character';
        const desc = (charData?.description || charData?.data?.description || '').trim();
        const scenario = (charData?.scenario || charData?.data?.scenario || '').trim();
        const personality = (charData?.personality || charData?.data?.personality || '').trim();
        const sysPrompt = (charData?.data?.system_prompt || '').trim();

        const parts = [];
        if (desc) parts.push(`Description & World Context:\n${desc}`);
        if (scenario) parts.push(`Scenario & Setting:\n${scenario}`);
        if (personality) parts.push(`Personality & Tone:\n${personality}`);
        if (sysPrompt) parts.push(`Custom Directives:\n${sysPrompt}`);

        if (!parts.length && !name) return null;

        const cardContent = parts.join('\n\n');
        const cardBlock = `[ACTIVE_CARD_CONTEXT]\nCard: ${name}${cardContent ? `\n${cardContent}` : ''}\n[/ACTIVE_CARD_CONTEXT]`;

        return { cardName: name, cardBlock, cardData };
    } catch (e) {
        console.warn('[Phone] _getActiveCardInfo failed:', e);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection settings helper — always falls back to ST's main API
// ─────────────────────────────────────────────────────────────────────────────

function getPhoneConnectionSettings(s) {
    // If user picked a dedicated phone connection, use those keys.
    // Otherwise fall back to 'default' (ST's main generateRaw API).
    if (s.phoneConnectionSource && s.phoneConnectionSource !== 'inherit') {
        return {
            connectionSource      : s.phoneConnectionSource,
            connectionProfileId   : s.phoneConnectionProfileId   || '',
            completionPresetId    : s.phoneCompletionPresetId    || '',
            ollamaUrl             : s.phoneOllamaUrl             || 'http://localhost:11434',
            ollamaModel           : s.phoneOllamaModel           || '',
            openaiUrl             : s.phoneOpenaiUrl             || '',
            openaiKey             : s.phoneOpenaiKey             || '',
            openaiModel           : s.phoneOpenaiModel           || '',
            maxTokens             : s.phoneMaxTokens             || 0,
        };
    }
    // Default: use the main ST API (generateRaw path)
    return {
        connectionSource      : 'default',
        connectionProfileId   : '',
        completionPresetId    : '',
        ollamaUrl             : '',
        ollamaModel           : '',
        openaiUrl             : '',
        openaiKey             : '',
        openaiModel           : '',
        maxTokens             : 0,
    };
}

/** Send a request using phone's AI connection */
async function sendPhoneRequest(systemPrompt, userPrompt) {
    const s = getSettings();
    const connSettings = getPhoneConnectionSettings(s);
    return sendStateRequest(connSettings, systemPrompt, userPrompt);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Injection (called by narrative-hooks.js interceptor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the [PHONE_ACTIVITY] injection block.
 * Injected on every turn matching [NPC_RELATIONS].
/**
 * Summarizes text into a clean single-line snippet for phone activity logs.
 * Strips HTML tags, image prompts, and extra whitespace.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
export function _summarizeText(text, maxLen = 140) {
    if (!text) return '';
    const clean = String(text)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\[IMAGE:[^\]]*\]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (clean.length <= maxLen) return clean;
    return clean.slice(0, maxLen - 1) + '…';
}

/**
 * Universal logger for ALL phone activities (calls, texts, browsing, reading, apps, camera, gallery).
 * Logs into `ps.phoneHistory` with story timestamps and keeps a large buffer (up to 500 events).
 * @param {string} type - 'call' | 'sms' | 'reddit' | 'web' | 'app' | 'camera' | 'gallery' | 'contact'
 * @param {string} contact - App name, website URL, NPC name, or module
 * @param {string} direction - 'in' | 'out'
 * @param {string} summary - Rich summary of what happened, what was seen, or what was written
 */
export function _logPhoneActivity(type, contact, direction, summary) {
    try {
        const ps = getPhoneState();
        if (!ps) return;
        if (!Array.isArray(ps.phoneHistory)) ps.phoneHistory = [];

        const cleanSummary = _summarizeText(summary, 280);
        if (!cleanSummary) return;

        // Prevent identical consecutive duplicate entries within 4 seconds
        const last = ps.phoneHistory[ps.phoneHistory.length - 1];
        if (last && last.type === type && last.contact === contact && last.summary === cleanSummary && (Date.now() - (last.timestamp || 0) < 4000)) {
            return;
        }

        const timeInfo = getInWorldTimeInfo();
        const turns = SillyTavern.getContext?.()?.chat?.length || 0;

        ps.phoneHistory.push({
            timestamp     : Date.now(),
            inWorldMinutes: timeInfo.totalMinutes,
            inWorldTimeStr: timeInfo.clockOnly || timeInfo.rawTime,
            turnNumber    : turns,
            relativeTime  : 'just now',
            type          : type || 'app',
            contact       : contact || 'Phone',
            direction     : direction || 'in',
            summary       : cleanSummary,
        });

        // Generous buffer (up to 500 events) so user history is never lost prematurely
        if (ps.phoneHistory.length > 500) {
            ps.phoneHistory.splice(0, ps.phoneHistory.length - 500);
        }

        savePhoneState();
    } catch (e) {
        console.warn('[Phone] _logPhoneActivity error:', e);
    }
}

/**
 * Builds the [PHONE_ACTIVITY] context block to inject before AI generation.
 * Injects recent calls, texts, web searches, visited websites, Reddit posts read/written, app actions, and photos.
 * @returns {string}
 */
export function buildPhoneContextBlock() {
    try {
        const s = getSettings();
        if (!s.phoneEnabled && !s.modules?.phone) return '';

        const ps = getPhoneState();
        if (!ps) return '';

        // Ensure relative times are fresh against the latest in-world [TIME]
        _updateRelativeTimes();

        const unread = ps.phoneUnread || { messages: 0, calls: 0 };
        const hasUnread = (unread.messages > 0) || (unread.calls > 0);

        // Allow up to 200 events (or whatever the user sets, default 20)
        const depth = Math.max(1, Math.min(200, s.phoneContextDepth || 20));
        const recent = (ps.phoneHistory || []).slice(-depth);
        if (!recent.length && !hasUnread) return '';

        const lines = recent.map(e => {
            const dir = e.direction === 'in' ? '← ' : '→ ';
            const ts  = e.relativeTime || '';
            const typeStr = (e.type || 'app').toUpperCase();
            return `${dir}${typeStr} [${e.contact}]: "${e.summary}"${ts ? ` (${ts})` : ''}`;
        });

        if (unread.calls > 0) {
            lines.unshift(`⚠ ${unread.calls} missed call(s)`);
        }
        if (unread.messages > 0) {
            lines.unshift(`💬 ${unread.messages} unread text message(s)`);
        }

        return `[PHONE_ACTIVITY]\n${lines.join('\n')}\n[/PHONE_ACTIVITY]\n\n`;
    } catch (e) {
        console.warn('[Phone] buildPhoneContextBlock error:', e);
        return '';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NPC Contact System
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maybe fire an NPC-initiated contact event after a generation ends.
 * Weighted by relationship scores — close friends call more, strangers almost never.
 * @param {string} combinedNarrative - The latest narrative text
 */
export async function maybeFireNpcContact(combinedNarrative) {
    _npcFiredThisTurn = false;
    try {
        const s = getSettings();
        if (!s.phoneEnabled && !s.modules?.phone) return;

        const baseChance = s.phoneNpcContactChance ?? 8;
        if (baseChance <= 0) return;
        if (Math.random() * 100 >= baseChance) return;

        // Gather NPCs and weight by relationship scores
        const relValues = s.npcRelationshipValues || {};
        const relMax    = s.npcRelationshipMax || 150;
        const candidates = [];

        for (const [npcId, vals] of Object.entries(relValues)) {
            const friendship = vals.friendship ?? 0;
            const affection  = vals.affection  ?? 0;
            const friendPct  = friendship / relMax;
            const affectPct  = affection  / relMax;

            // Weight formula: close friends high, acquaintances low, strangers near-zero
            let weight = 0.1; // base weight even for strangers
            if (friendPct >= 0.4)  weight += 2.0 * friendPct;
            if (friendPct >= 0.2)  weight += 0.5;
            if (affectPct >= 0.33) weight += 1.5 * affectPct;

            candidates.push({ npcId, weight });
        }

        if (!candidates.length) return;

        // Weighted random pick
        const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
        let rand = Math.random() * totalWeight;
        let chosenNpc = candidates[0].npcId;
        for (const c of candidates) {
            rand -= c.weight;
            if (rand <= 0) { chosenNpc = c.npcId; break; }
        }

        // Clean display name — strip internal lorebook key suffixes like _NPCs::0
        const displayName = chosenNpc
            .replace(/_NPCs::\d+$/, '')
            .replace(/_\d{4}_\d{2}_\d{2}_\d+h\d+m\d+s\w+$/, '')
            .replace(/_/g, ' ')
            .trim();

        let cardBlockStr = '';
        if (s.phoneIncludeCardContext !== false) {
            const cardInfo = _getActiveCardInfo();
            if (cardInfo?.cardBlock) {
                cardBlockStr = `${cardInfo.cardBlock}\n\n`;
            }
        }

        // Ask AI if this NPC would actually reach out right now
        const snippedNarrative = combinedNarrative.slice(-1500);
        const systemPrompt = `You decide if an NPC should contact the player via phone right now. Be realistic and conservative — only say yes when it genuinely fits the current situation. Reply ONLY with valid JSON.`;
        const userPrompt   = `${cardBlockStr}NPC: ${displayName}
Recent story events:
${snippedNarrative}

Would ${displayName} realistically reach out to the player right now via phone?
Consider: their relationship, what just happened, urgency, time of day.
Reply ONLY with: {"contact": true, "type": "text"|"call"|"missed_call", "message": "<what they say or null for missed_call>"} or {"contact": false}`;

        let raw;
        try {
            raw = await sendPhoneRequest(systemPrompt, userPrompt);
        } catch { return; }

        let parsed;
        try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return;
            parsed = JSON.parse(jsonMatch[0]);
        } catch { return; }

        if (!parsed.contact) return;

        // Record the contact event
        const ps = getPhoneState();
        if (!ps) return;

        const timeInfo = getInWorldTimeInfo();
        _logPhoneActivity(parsed.type || 'sms', chosenNpc, 'in', parsed.message || (parsed.type === 'missed_call' ? 'Missed call' : 'Contact event'));

        if (parsed.type === 'text' && parsed.message) {
            if (!ps.phoneMessages[chosenNpc]) ps.phoneMessages[chosenNpc] = [];
            ps.phoneMessages[chosenNpc].push({
                text          : parsed.message,
                direction     : 'in',
                timestamp     : Date.now(),
                inWorldMinutes: timeInfo.totalMinutes,
                inWorldTimeStr: timeInfo.clockOnly || timeInfo.rawTime,
            });
            ps.phoneUnread.messages = (ps.phoneUnread.messages || 0) + 1;
        } else if (parsed.type === 'missed_call') {
            ps.phoneUnread.calls = (ps.phoneUnread.calls || 0) + 1;
        }

        _npcFiredThisTurn = true;
        savePhoneState();
        _updateNotificationBadge();

        // If phone is open, refresh the current view
        if (_isOpen) _renderCurrentPage();

    } catch (e) {
        console.warn('[Phone] maybeFireNpcContact error:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-World Time Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves current in-world time details from settings/currentMemo.
 * @returns {{ rawTime: string, clockOnly: string, totalMinutes: number|null }}
 */
export function getInWorldTimeInfo() {
    try {
        const s = getSettings();
        const memo = s?.currentMemo || '';
        const timeMatch = memo.match(/\[TIME\]([\s\S]*?)\[\/TIME\]/i);
        const rawTime = timeMatch ? extractCurrentTimeStr(timeMatch[1]) : (s?.initialTime || '');

        let totalMinutes = null;
        let clockOnly = '';

        if (rawTime) {
            totalMinutes = parseInWorldTime(rawTime);
            // Match time pattern like 08:00 AM or 14:30
            const tMatch = rawTime.match(/(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i);
            if (tMatch) {
                clockOnly = tMatch[1].trim();
            }
        }

        if (!clockOnly && totalMinutes != null) {
            const remMinutes = ((totalMinutes % 1440) + 1440) % 1440;
            const h = Math.floor(remMinutes / 60);
            const m = remMinutes % 60;
            const use24h = !!s?.use24hTime;
            if (use24h) {
                clockOnly = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            } else {
                const mer = h >= 12 ? 'PM' : 'AM';
                const h12 = h % 12 || 12;
                clockOnly = `${h12}:${String(m).padStart(2, '0')} ${mer}`;
            }
        }

        if (!clockOnly) {
            clockOnly = '12:00 PM';
        }

        return { rawTime, clockOnly, totalMinutes };
    } catch {
        return { rawTime: '', clockOnly: '12:00 PM', totalMinutes: null };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Turn tracking — called by narrative-hooks.js at generation start/end
// ─────────────────────────────────────────────────────────────────────────────

export function onPhoneGenerationStarted() {
    _phoneUsedThisTurn = false;
    _npcFiredThisTurn  = false;
    // Update in-game relative times
    _updateRelativeTimes();
    _updateStatusBar();
}

function _markPhoneUsed() {
    _phoneUsedThisTurn = true;
}

function _updateRelativeTimes() {
    try {
        const ps = getPhoneState();
        if (!ps || !Array.isArray(ps.phoneHistory)) return;

        const currentInfo = getInWorldTimeInfo();
        const currentMins = currentInfo.totalMinutes;
        const currentTurns = SillyTavern.getContext?.()?.chat?.length || 0;

        for (const e of ps.phoneHistory) {
            // 1. In-world minutes difference
            if (e.inWorldMinutes != null && currentMins != null) {
                const diffM = currentMins - e.inWorldMinutes;
                if (diffM <= 0) {
                    e.relativeTime = 'just now';
                } else if (diffM < 60) {
                    e.relativeTime = `${diffM}m ago`;
                } else if (diffM < 1440) {
                    const h = Math.floor(diffM / 60);
                    const m = diffM % 60;
                    e.relativeTime = m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
                } else {
                    const days = Math.floor(diffM / 1440);
                    e.relativeTime = days === 1 ? '1 day ago' : `${days}d ago`;
                }
            }
            // 2. Chat turn difference fallback
            else if (e.turnNumber != null && currentTurns != null) {
                const diffTurns = currentTurns - e.turnNumber;
                if (diffTurns <= 0) {
                    e.relativeTime = 'just now';
                } else if (diffTurns === 1) {
                    e.relativeTime = '1 turn ago';
                } else {
                    e.relativeTime = `${diffTurns} turns ago`;
                }
            }
            // 3. Static fallback
            else if (e.inWorldTimeStr) {
                e.relativeTime = `at ${e.inWorldTimeStr}`;
            } else {
                e.relativeTime = 'just now';
            }
        }
    } catch (err) {
        console.warn('[Phone] _updateRelativeTimes error:', err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification badge
// ─────────────────────────────────────────────────────────────────────────────

function _updateNotificationBadge() {
    try {
        const ps = getPhoneState();
        const total = ps ? (ps.phoneUnread.messages + ps.phoneUnread.calls) : 0;
        const badge = document.getElementById('rpg_phone_icon_badge');
        if (!badge) return;
        badge.style.display = total > 0 ? 'flex' : 'none';
        badge.textContent   = total > 9 ? '9+' : String(total);
    } catch { }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone panel open / close / toggle
// ─────────────────────────────────────────────────────────────────────────────

export function openPhone() {
    if (!_phoneEl) _buildPhonePanel();
    _isOpen = true;
    _phoneEl.style.display = 'flex';
    _applyGenreSkin();
    _updateStatusBar();
    _navigateHome();
    document.getElementById('rpg_phone_icon_badge')?.classList.add('rpg-phone-icon-active');
}

export function closePhone() {
    _isOpen = false;
    if (_phoneEl) _phoneEl.style.display = 'none';
    document.getElementById('rpg_phone_icon_badge')?.classList.remove('rpg-phone-icon-active');
}

export function togglePhone() {
    _isOpen ? closePhone() : openPhone();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone panel construction
// ─────────────────────────────────────────────────────────────────────────────

function _buildPhonePanel() {
    if (_phoneEl) return;

    _phoneEl = document.createElement('div');
    _phoneEl.className = 'rpg-phone';
    _phoneEl.id = 'rpg_phone_panel';
    _phoneEl.style.display = 'none';
    _phoneEl.innerHTML = _phoneShellHTML();

    document.body.appendChild(_phoneEl);

    // Close button
    _phoneEl.querySelector('#rpg_phone_close_btn')?.addEventListener('click', closePhone);

    // Back button
    _phoneEl.querySelector('#rpg_phone_back_btn')?.addEventListener('click', _navigateBack);
    _phoneEl.querySelector('#rpg_phone_refresh_btn')?.addEventListener('click', () => { if (typeof globalThis._rpgPhoneRefreshCb === 'function') globalThis._rpgPhoneRefreshCb(); });

    // Home button
    _phoneEl.querySelector('#rpg_phone_home_btn')?.addEventListener('click', _navigateHome);

    // Update status bar every minute
    setInterval(_updateStatusBar, 60000);
}

function _phoneShellHTML() {
    return `
<div class="rpg-phone-shell">
  <div class="rpg-phone-notch"></div>
  <div class="rpg-phone-statusbar" id="rpg_phone_statusbar">
    <span class="rpg-phone-time" id="rpg_phone_time">12:00</span>
    <div class="rpg-phone-statusbar-icons">
      <span class="rpg-phone-signal">▐▐▐</span>
      <span class="rpg-phone-battery" id="rpg_phone_battery">🔋</span>
    </div>
  </div>

  <div class="rpg-phone-navbar" id="rpg_phone_navbar">
    <button class="rpg-phone-nav-btn" id="rpg_phone_back_btn" title="Back">‹</button>
    <span class="rpg-phone-nav-title" id="rpg_phone_nav_title"></span>
    <button class="rpg-phone-nav-btn" id="rpg_phone_refresh_btn" title="Refresh" style="display:none;font-size:16px;padding-top:2px">↻</button>
    <button class="rpg-phone-nav-btn rpg-phone-close-btn" id="rpg_phone_close_btn" title="Close phone">✕</button>
  </div>

  <div class="rpg-phone-screen" id="rpg_phone_screen">
    <!-- Dynamic content rendered here -->
  </div>

  <div class="rpg-phone-dock">
    <button class="rpg-phone-dock-btn" data-app="dialer"   title="Phone">📞</button>
    <button class="rpg-phone-dock-btn" data-app="messages" title="Messages">💬</button>
    <button class="rpg-phone-home-btn" id="rpg_phone_home_btn" title="Home">⚪</button>
    <button class="rpg-phone-dock-btn" data-app="camera"   title="Camera">📷</button>
    <button class="rpg-phone-dock-btn" data-app="contacts" title="Contacts">👥</button>
  </div>
</div>
`;
}

function _applyGenreSkin() {
    if (!_phoneEl) return;
    const s = getSettings();
    const genre = s.onboardingGenre || 'realistic';
    // Remove all skin classes
    _phoneEl.classList.remove('rpg-phone--scifi', 'rpg-phone--horror');
    const skin = GENRE_SKIN[genre];
    if (skin) _phoneEl.classList.add(skin);
}

function _updateStatusBar() {
    if (!_phoneEl) return;
    const timeEl = _phoneEl.querySelector('#rpg_phone_time');
    if (timeEl) {
        const timeInfo = getInWorldTimeInfo();
        timeEl.textContent = timeInfo.clockOnly;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────────────────────────────────────

function _navigateHome() {
    _pageStack = [];
    _currentApp = null;
    _setNavTitle('');
    _setBackVisible(false);
    _renderHomeScreen();
}

function _navigateTo(appId, pageId = 'home', params = {}) {
    _pageStack.push({ appId, pageId, params });
    _currentApp = appId;
    _setBackVisible(true);
    _renderPage(appId, pageId, params);
}

function _navigateBack() {
    if (_pageStack.length <= 1) {
        _navigateHome();
        return;
    }
    _pageStack.pop();
    const prev = _pageStack[_pageStack.length - 1];
    _currentApp = prev.appId;
    _renderPage(prev.appId, prev.pageId, prev.params);
    if (_pageStack.length <= 1) _setBackVisible(false);
}

function _renderCurrentPage() {
    if (!_pageStack.length) { _renderHomeScreen(); return; }
    const cur = _pageStack[_pageStack.length - 1];
    _renderPage(cur.appId, cur.pageId, cur.params);
}

function _setNavTitle(title) {
    const el = _phoneEl?.querySelector('#rpg_phone_nav_title');
    if (el) el.textContent = title;
}

function _setBackVisible(vis) {
    const btn = _phoneEl?.querySelector('#rpg_phone_back_btn');
    if (btn) btn.style.visibility = vis ? 'visible' : 'hidden';
}

function _setRefreshAction(cb) {
    const btn = _phoneEl?.querySelector('#rpg_phone_refresh_btn');
    if (btn) {
        btn.style.display = typeof cb === 'function' ? 'block' : 'none';
        globalThis._rpgPhoneRefreshCb = cb;
    }
}

function _getScreen() {
    return _phoneEl?.querySelector('#rpg_phone_screen');
}

// ─────────────────────────────────────────────────────────────────────────────
// Home Screen
// ─────────────────────────────────────────────────────────────────────────────

function _renderHomeScreen() {
    const screen = _getScreen();
    if (!screen) return;

    const ps = getPhoneState();
    const unread = ps?.phoneUnread || { messages: 0, calls: 0 };
    const msgBadge  = unread.messages > 0 ? `<span class="rpg-phone-app-badge">${unread.messages}</span>` : '';
    const callBadge = unread.calls    > 0 ? `<span class="rpg-phone-app-badge">${unread.calls}</span>`   : '';

    // Built-in apps
    const builtinApps = [
        { id: 'google',    icon: '🔍', label: 'Google'    },
        { id: 'reddit',    icon: '🤖', label: 'Reddit'    },
        { id: 'appstore',  icon: '🏪', label: 'App Store' },
        { id: 'messages',  icon: '💬', label: 'Messages', badge: msgBadge  },
        { id: 'dialer',    icon: '📞', label: 'Phone',    badge: callBadge },
        { id: 'contacts',  icon: '👥', label: 'Contacts'  },
        { id: 'camera',    icon: '📷', label: 'Camera'    },
        { id: 'gallery',   icon: '🖼️', label: 'Gallery'   },
        { id: 'settings',  icon: '⚙️', label: 'Settings'  },
    ];

    // Installed user apps
    const installedApps = (ps?.phoneApps || []).map(app => ({
        id      : `installed_${app.id}`,
        icon    : app.icon || '📱',
        label   : app.name,
        installed: true,
    }));

    const allApps = [...builtinApps, ...installedApps];

    const iconsHTML = allApps.map(app => `
<div class="rpg-phone-app-icon" data-app="${app.id}" role="button" tabindex="0" aria-label="${app.label}">
  <div class="rpg-phone-app-icon-img">${app.icon}${app.badge || ''}</div>
  <div class="rpg-phone-app-icon-label">${app.label}</div>
</div>`).join('');

    screen.innerHTML = `<div class="rpg-phone-homescreen">${iconsHTML}</div>`;

    // Bind click events
    screen.querySelectorAll('.rpg-phone-app-icon').forEach(el => {
        el.addEventListener('click', () => {
            const appId = el.dataset.app;
            _navigateTo(appId);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Image parsing
// ─────────────────────────────────────────────────────────────────────────────

function _parsePhoneImages(text) {
    if (!text) return '';
    return text.replace(/\[IMAGE:\s*(.*?)\]/gi, (match, desc) => {
        const cleanDesc = desc.trim();
        return `<div class="rpg-phone-image-placeholder" data-img-prompt="${_escHtml(cleanDesc)}" role="button" tabindex="0">
            <div class="rpg-phone-image-prompt" style="display:none">${_escHtml(cleanDesc)}</div>
            <span>🖼️ Click to generate image</span>
        </div>`;
    });
}

function _bindPhoneImages(screen) {
    if (!screen) return;
    screen.querySelectorAll('.rpg-phone-image-placeholder').forEach(el => {
        if (el._hasImgListener) return;
        el._hasImgListener = true;

        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (el.dataset.generating === 'true') return;
            const desc = el.dataset.imgPrompt;
            if (!desc) return;
            el.dataset.generating = 'true';
            el.innerHTML = '<span>⏳ Opening image generator…</span>';

            const onImageReady = (dataUrl) => {
                if (dataUrl) {
                    el.innerHTML = `<img src="${_escHtml(dataUrl)}" class="rpg-phone-generated-image" style="width:100%; border-radius:8px; cursor:pointer; display:block;" onclick="window.open(this.src,'_blank')" />`;
                    el.style.border = 'none';
                    el.style.padding = '0';
                    el.style.background = 'transparent';
                    el.dataset.generating = 'done';
                } else {
                    el.dataset.generating = '';
                    el.innerHTML = '<span>🖼️ Click to generate image</span>';
                }
            };

            try {
                const s = getSettings();
                if (typeof showPortraitPromptPopup === 'function' && !s.portraitSkipPromptDialog) {
                    await showPortraitPromptPopup(desc, 'Phone Image', onImageReady, () => {});
                } else if (typeof generatePortraitDirect === 'function') {
                    el.innerHTML = '<span>⏳ Generating image…</span>';
                    const dataUrl = await generatePortraitDirect(desc, 'Phone Image');
                    if (dataUrl) onImageReady(dataUrl);
                } else if (typeof globalThis._rpgGenerateImage === 'function') {
                    el.innerHTML = '<span>⏳ Generating image…</span>';
                    const dataUrl = await globalThis._rpgGenerateImage(desc);
                    if (dataUrl) onImageReady(dataUrl);
                } else {
                    el.dataset.generating = '';
                    el.innerHTML = '<span style="color:#ff6b6b">Image generator not configured.</span>';
                }
            } catch (err) {
                el.dataset.generating = '';
                el.innerHTML = `<span style="color:#ff6b6b">❌ Failed: ${_escHtml(err.message || String(err))}</span>`;
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Page router
// ─────────────────────────────────────────────────────────────────────────────

function _renderPage(appId, pageId, params) {
    const screen = _getScreen();
    if (!screen) return;

    _setRefreshAction(null);
    // Loading state
    screen.innerHTML = `<div class="rpg-phone-loading"><div class="rpg-phone-spinner"></div><p>Loading…</p></div>`;

    // Dispatch to app renderer
    switch (appId) {
        case 'google':   return _renderGoogleApp(pageId, params, screen);
        case 'reddit':   return _renderRedditApp(pageId, params, screen);
        case 'appstore': return _renderAppStoreApp(pageId, params, screen);
        case 'messages': return _renderMessagesApp(pageId, params, screen);
        case 'dialer':   return _renderDialerApp(pageId, params, screen);
        case 'contacts': return _renderContactsApp(pageId, params, screen);
        case 'camera':   return _renderCameraApp(pageId, params, screen);
        case 'gallery':  return _renderGalleryApp(pageId, params, screen);
        case 'settings': return _renderPhoneSettingsApp(pageId, params, screen);
        default:
            if (appId.startsWith('installed_')) {
                return _renderInstalledApp(appId.replace('installed_', ''), pageId, params, screen);
            }
            screen.innerHTML = `<div class="rpg-phone-error">App not found.</div>`;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE APP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight scene context for Google / Reddit / App Store prompts.
 * Returns Player Character block + recent chat history sized to the player's context window.
 * Does NOT include State Tracker memo or combat stats.
 * @param {number} [overhead=1200] chars reserved for system prompt + JSON response
 * @returns {string}
 */
function _buildSceneContext(overhead = 1200) {
    const stContext   = SillyTavern.getContext?.() || {};
    const contextSize = stContext?.contextSize || 8192;
    const s           = getSettings();
    const { pcName, pcBlock } = _getPlayerCharacterInfo();

    let cardBlockStr = '';
    if (s.phoneIncludeCardContext !== false) {
        const cardInfo = _getActiveCardInfo();
        if (cardInfo?.cardBlock) {
            cardBlockStr = `${cardInfo.cardBlock}\n\n`;
        }
    }

    const pcBlockStr = pcBlock ? `${pcBlock}\n\n` : '';
    const staticHeader = `${cardBlockStr}${pcBlockStr}`;
    const dynamicOverhead = overhead + Math.ceil(staticHeader.length / 3.5);
    const charBudget  = Math.floor((contextSize - dynamicOverhead) * 3.5);

    const chat = stContext?.chat;
    if (!Array.isArray(chat) || !chat.length) return staticHeader.trim();

    const lines = [];
    let usedChars = staticHeader.length;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        const raw = String(m.mes || m.content || '').trim();
        const text = cleanToolCallMessage(raw);
        if (!text) continue;
        const name = m.is_user ? pcName : (m.name || 'Narrator');
        const line = `${name}: ${text}`;
        if (usedChars + line.length > charBudget) break;
        lines.unshift(line);
        usedChars += line.length + 1;
    }
    const historyBlock = lines.length ? `## RECENT STORY EVENTS\n${lines.join('\n\n')}` : '';
    return `${staticHeader}${historyBlock}`.trim();
}

async function _renderGoogleApp(pageId, params, screen) {
    _setNavTitle('Google');

    if (pageId === 'home' || !pageId) {
        screen.innerHTML = `
<div class="rpg-phone-google-home">
  <div class="rpg-phone-google-logo">Google</div>
  <div class="rpg-phone-search-bar-wrap">
    <input type="text" class="rpg-phone-search-input" id="rpg_phone_google_input" placeholder="Search…" autocomplete="off"/>
    <button class="rpg-phone-search-btn" id="rpg_phone_google_search_btn">🔍</button>
  </div>
  <button class="rpg-phone-feeling-lucky" id="rpg_phone_lucky_btn">I'm Feeling Lucky</button>
</div>`;

        const doSearch = () => {
            const q = document.getElementById('rpg_phone_google_input')?.value?.trim();
            if (q) _navigateTo('google', 'results', { query: q });
        };
        document.getElementById('rpg_phone_google_search_btn')?.addEventListener('click', doSearch);
        document.getElementById('rpg_phone_google_input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') doSearch();
        });

        document.getElementById('rpg_phone_lucky_btn')?.addEventListener('click', () => {
            const q = document.getElementById('rpg_phone_google_input')?.value?.trim() || 'something interesting';
            _navigateTo('google', 'lucky', { query: q });
        });
        return;
    }

    if (pageId === 'results') {
        _setNavTitle(`"${params.query}"`);
        _markPhoneUsed();
        const ps = getPhoneState();
        const cacheKey = `google_q_${params.query}`;
        let results = ps?.phoneCache?.[cacheKey];
        if (!results) {
            try {
                const sceneCtx = _buildSceneContext(1200);
                const sys = `You simulate Google search results for a realistic modern roleplay setting. Return ONLY a JSON array of exactly 5 result objects, no prose, no markdown fences.`;
                const usr = `## RECENT STORY EVENTS\n${sceneCtx}\n\nSearch query: "${params.query}"\nReturn 5 results grounded in this world and the query. If a result snippet realistically contains an image, include "[IMAGE: detailed visual description]":\n[{"title":"...","url":"https://...","snippet":"..."}]`;
                const raw = await sendPhoneRequest(sys, usr);
                const match = raw.match(/\[[\s\S]*\]/);
                results = match ? JSON.parse(match[0]) : [];
                if (ps && results.length) { ps.phoneCache[cacheKey] = results; savePhoneState(); }
            } catch (e) {
                screen.innerHTML = `<div class="rpg-phone-error">Search failed.<br><small>${_escHtml(String(e))}</small></div>`;
                _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
                return;
            }
        }

        // Log search activity to context
        _logPhoneActivity('web', 'Google', 'out', `Searched "${params.query}" (Found ${results.length} results: ${results.slice(0, 3).map(r => r.title).join(', ')})`);

        const items = results.map((r, i) => `
<div class="rpg-phone-search-result" data-idx="${i}" role="button" tabindex="0">
  <div class="rpg-phone-result-url">${_escHtml(r.url || '')}</div>
  <div class="rpg-phone-result-title">${_escHtml(r.title || '')}</div>
  <div class="rpg-phone-result-snippet">${_parsePhoneImages(_escHtml(r.snippet || ''))}</div>
</div>`).join('');
        screen.innerHTML = `
<div class="rpg-phone-results-header">
  <span class="rpg-phone-results-query">Results for "${_escHtml(params.query)}"</span>
</div>
<div class="rpg-phone-results-list">${items}</div>`;
        screen.querySelectorAll('.rpg-phone-search-result').forEach((el, i) => {
            el.addEventListener('click', () => {
                _navigateTo('google', 'webpage', { url: results[i].url, title: results[i].title, query: params.query });
            });
        });
        _bindPhoneImages(screen);
        _setRefreshAction(() => { if(ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
        return;
    }

    if (pageId === 'webpage') {
        _setNavTitle(params.url || 'Web');
        _markPhoneUsed();
        const ps = getPhoneState();
        const cacheKey = `google_page_${params.url}`;
        let html = ps?.phoneCache?.[cacheKey];
        if (!html) {
            try {
                const sceneCtx = _buildSceneContext(1500);
                const sys = `You simulate a realistic web page in a modern roleplay setting. Clean HTML with inline styles only — no external resources, no scripts, no html/head/body tags. Inner content only. Headings, paragraphs, lists as appropriate. Under 500 words.`;
                const usr = `## RECENT STORY EVENTS\n${sceneCtx}\n\nURL: ${params.url}\nTitle: ${params.title || ''}\nQuery that led here: "${params.query || ''}"\nGenerate the page. Make it feel authentic to this world. If the page contains images, include "[IMAGE: detailed visual description]".`;
                html = await sendPhoneRequest(sys, usr);
                if (ps && html) { ps.phoneCache[cacheKey] = html; savePhoneState(); }
            } catch {
                screen.innerHTML = `<div class="rpg-phone-error">Could not load page.</div>`;
                _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
                return;
            }
        }

        // Log visited page activity to context
        _logPhoneActivity('web', params.title || params.url || 'Webpage', 'in', `Read webpage "${params.title || params.url}": ${_summarizeText(html, 180)}`);

        screen.innerHTML = `
<div class="rpg-phone-webpage">
  <div class="rpg-phone-webpage-urlbar">${_escHtml(params.url || '')}</div>
  <div class="rpg-phone-webpage-content">${_parsePhoneImages(html)}</div>
  <div class="rpg-phone-webpage-more">
    <button class="rpg-phone-btn-small" id="rpg_phone_webpage_links">🔗 More from this site</button>
  </div>
</div>`;
        document.getElementById('rpg_phone_webpage_links')?.addEventListener('click', () => {
            _navigateTo('google', 'results', { query: `site:${params.url} ${params.query || ''}` });
        });
        _bindPhoneImages(screen);
        _setRefreshAction(() => { if(ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// REDDIT APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderRedditApp(pageId, params, screen) {
    _setNavTitle('Reddit');
    const ps = getPhoneState();

    if (pageId === 'home') {
        _markPhoneUsed();
        const cacheKey = 'reddit_home';
        let subs = ps?.phoneCache?.[cacheKey];
        if (!subs) {
            try {
                const sceneCtx = _buildSceneContext(800);
                const sys = `You simulate the Reddit front page for a modern roleplay setting. Return ONLY a JSON array, no prose, no markdown.`;
                const usr = `## RECENT STORY EVENTS\n${sceneCtx}\n\nReturn a JSON array of 6 subreddits relevant to this world:\n[{"name":"r/...","description":"...","icon":"<single emoji>"}]`;
                const raw  = await sendPhoneRequest(sys, usr);
                const m    = raw.match(/\[[\s\S]*\]/);
                subs = m ? JSON.parse(m[0]) : [];
                if (ps && subs.length) { ps.phoneCache[cacheKey] = subs; savePhoneState(); }
            } catch {
                screen.innerHTML = `<div class="rpg-phone-error">Reddit unavailable.</div>`;
                _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
                return;
            }
        }

        // Log Reddit frontpage browsing
        _logPhoneActivity('reddit', 'Reddit', 'in', `Browsed subreddits (${subs.slice(0, 4).map(s => s.name).join(', ')})`);

        const tiles = subs.map(sub => `
<div class="rpg-phone-reddit-sub" data-sub="${_escHtml(sub.name)}" role="button" tabindex="0">
  <span class="rpg-phone-reddit-sub-icon">${sub.icon || '🤖'}</span>
  <div>
    <div class="rpg-phone-reddit-sub-name">${_escHtml(sub.name)}</div>
    <div class="rpg-phone-reddit-sub-desc">${_escHtml(sub.description || '')}</div>
  </div>
</div>`).join('');
        screen.innerHTML = `
<div class="rpg-phone-reddit-header">
  <span class="rpg-phone-reddit-logo">🤖 reddit</span>
  <input type="text" class="rpg-phone-search-input" id="rpg_phone_reddit_search" placeholder="Go to subreddit…"/>
</div>
<div class="rpg-phone-reddit-subs">${tiles}</div>`;
        screen.querySelectorAll('.rpg-phone-reddit-sub').forEach(el => {
            el.addEventListener('click', () => _navigateTo('reddit', 'subreddit', { sub: el.dataset.sub }));
        });
        document.getElementById('rpg_phone_reddit_search')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const q = e.target.value.trim();
                if (q) _navigateTo('reddit', 'subreddit', { sub: q.startsWith('r/') ? q : `r/${q}` });
            }
        });
        _setRefreshAction(() => { if(ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
        return;
    }

    if (pageId === 'subreddit') {
        _setNavTitle(params.sub || 'r/subreddit');
        _markPhoneUsed();
        const cacheKey = `reddit_feed_${params.sub}`;
        let posts = ps?.phoneCache?.[cacheKey];
        if (!posts) {
            try {
                const sceneCtx = _buildSceneContext(1000);
                const sys = `You simulate a Reddit subreddit feed for a modern roleplay setting. Return ONLY a JSON array.`;
                const usr = `## RECENT STORY EVENTS\n${sceneCtx}\n\nSubreddit: ${params.sub}\nGenerate 8 realistic posts grounded in this world. If a post realistically contains an image, include "[IMAGE: detailed visual description]" in its preview text.\nReturn ONLY this JSON array:\n[{"id":"p1","title":"...","flair":"...","upvotes":1234,"comments":56,"author":"u/...","preview":"one sentence"}]`;
                const raw  = await sendPhoneRequest(sys, usr);
                const m    = raw.match(/\[[\s\S]*\]/);
                posts = m ? JSON.parse(m[0]) : [];
                if (ps && posts.length) { ps.phoneCache[cacheKey] = posts; savePhoneState(); }
            } catch {
                screen.innerHTML = `<div class="rpg-phone-error">Could not load feed.</div>`;
                _setRefreshAction(() => { delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
                return;
            }
        }

        // Log Subreddit browsing to phone context
        _logPhoneActivity('reddit', params.sub || 'r/all', 'in', `Browsed ${params.sub} feed (Top posts: ${posts.slice(0, 3).map(p => p.title).join(' | ')})`);

        const renderFeed = () => {
            const ps2 = getPhoneState();
            const items = posts.map(p => {
                const vote  = ps2?.phoneVotes?.[p.id] || 0;
                const score = (p.upvotes || 0) + vote;
                return `
<div class="rpg-phone-reddit-post" data-id="${_escHtml(p.id)}" role="button" tabindex="0">
  ${p.flair ? `<span class="rpg-phone-reddit-flair">${_escHtml(p.flair)}</span>` : ''}
  <div class="rpg-phone-reddit-post-title">${_escHtml(p.title)}</div>
  <div class="rpg-phone-reddit-post-meta">
    <button class="rpg-phone-vote-btn${vote===1?' voted-up':''}" data-post="${_escHtml(p.id)}" data-dir="1">▲</button>
    <span class="rpg-phone-vote-score${vote===1?' vote-up':vote===-1?' vote-down':''}">${score}</span>
    <button class="rpg-phone-vote-btn${vote===-1?' voted-down':''}" data-post="${_escHtml(p.id)}" data-dir="-1">▼</button>
    <span style="margin-left:8px;">💬 ${p.comments || 0}</span>
    <span>${_escHtml(p.author || '')}</span>
  </div>
  <div class="rpg-phone-reddit-post-preview">${_parsePhoneImages(_escHtml(p.preview || ''))}</div>
</div>`;
            }).join('');
            screen.innerHTML = `
<div class="rpg-phone-reddit-sub-header">${_escHtml(params.sub)}</div>
<div class="rpg-phone-reddit-feed">${items}</div>`;
            screen.querySelectorAll('.rpg-phone-reddit-post').forEach((el, i) => {
                el.addEventListener('click', ev => {
                    if (ev.target.closest('.rpg-phone-vote-btn')) return;
                    _navigateTo('reddit', 'post', { sub: params.sub, post: posts[i], postId: posts[i]?.id, cacheKey });
                });
            });
            screen.querySelectorAll('.rpg-phone-vote-btn').forEach(btn => {
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    const postId = btn.dataset.post;
                    const dir    = parseInt(btn.dataset.dir, 10);
                    const ps3    = getPhoneState();
                    if (!ps3) return;
                    const cur = ps3.phoneVotes[postId] || 0;
                    ps3.phoneVotes[postId] = cur === dir ? 0 : dir;
                    savePhoneState();
                    renderFeed();
                });
            });
            _bindPhoneImages(screen);
            _setRefreshAction(() => { if (ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
        };
        renderFeed();
        return;
    }

    if (pageId === 'post') {
        let post = params.post;
        if (!post && params.postId && params.cacheKey) {
            const feed = ps?.phoneCache?.[params.cacheKey] || [];
            post = feed.find(p => p.id === params.postId) || {};
        }
        post = post || {};
        const postTitle = post.title || 'Discussion';
        _setNavTitle(postTitle);
        _markPhoneUsed();

        const { pcName } = _getPlayerCharacterInfo();
        const detailKey = `reddit_post_${post.id || postTitle}`;
        let data = ps?.phoneCache?.[detailKey];
        if (!data) {
            try {
                const sceneCtx = _buildSceneContext(1000);
                const sys = `You simulate a Reddit post and comments thread for a modern roleplay setting. Return ONLY valid JSON.`;
                const usr = `${sceneCtx}\n\nSubreddit: ${params.sub || 'r/all'}\nPost Title: "${postTitle}"\nPost Flair: "${post.flair || ''}"\nPost Author: "${post.author || 'u/Anonymous'}"\nGenerate the full post body and top 5 comments with realistic replies. If the post realistically contains an image, include "[IMAGE: detailed visual description]" in its body text:\n{"body":"<post text>","comments":[{"author":"u/...","upvotes":123,"text":"...","replies":[{"author":"u/...","upvotes":45,"text":"..."}]}]}`;
                const raw  = await sendPhoneRequest(sys, usr);
                const m    = raw.match(/\{[\s\S]*\}/);
                data = m ? JSON.parse(m[0]) : { body: '', comments: [] };
                if (ps && data) { ps.phoneCache[detailKey] = data; savePhoneState(); }
            } catch {
                screen.innerHTML = `<div class="rpg-phone-error">Could not load post.</div>`;
                _setRefreshAction(() => { if (ps) delete ps.phoneCache[detailKey]; _renderCurrentPage(); });
                return;
            }
        }

        // Log reading Reddit post to phone activity
        _logPhoneActivity('reddit', params.sub || 'r/all', 'in', `Read post "${postTitle}" by ${post.author || 'anon'} — "${_summarizeText(data.body, 140)}" (${(data.comments || []).length} comments)`);

        const renderPost = () => {
            const ps2 = getPhoneState();
            const vote  = ps2?.phoneVotes?.[post.id] || 0;
            const score = (post.upvotes || 0) + vote;
            const userName = `u/${(pcName || 'Player').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

            const commentsHTML = (data.comments || []).map(c => {
                const replies = (c.replies || []).map(r => `
<div class="rpg-phone-reddit-reply">
  <span class="rpg-phone-reddit-comment-author">${_escHtml(r.author)}</span>
  <span class="rpg-phone-reddit-comment-up">▲ ${r.upvotes || 0}</span>
  <div class="rpg-phone-reddit-comment-text">${_parsePhoneImages(_escHtml(r.text))}</div>
</div>`).join('');
                return `
<div class="rpg-phone-reddit-comment">
  <span class="rpg-phone-reddit-comment-author">${_escHtml(c.author)}</span>
  <span class="rpg-phone-reddit-comment-up">▲ ${c.upvotes || 0}</span>
  <div class="rpg-phone-reddit-comment-text">${_parsePhoneImages(_escHtml(c.text))}</div>
  ${replies ? `<div class="rpg-phone-reddit-replies">${replies}</div>` : ''}
</div>`;
            }).join('');

            screen.innerHTML = `
<div class="rpg-phone-reddit-post-detail">
  ${post.flair ? `<span class="rpg-phone-reddit-flair">${_escHtml(post.flair)}</span>` : ''}
  <h3 class="rpg-phone-reddit-post-detail-title">${_escHtml(postTitle)}</h3>
  <div class="rpg-phone-reddit-post-body">${_parsePhoneImages(_escHtml(data.body || ''))}</div>
  <div class="rpg-phone-reddit-post-actions">
    <button class="rpg-phone-vote-btn${vote===1?' voted-up':''}" id="rpg_post_up">▲</button>
    <span class="rpg-phone-vote-score${vote===1?' vote-up':vote===-1?' vote-down':''}" id="rpg_post_score">${score}</span>
    <button class="rpg-phone-vote-btn${vote===-1?' voted-down':''}" id="rpg_post_dn">▼</button>
    <span style="margin-left:12px;">💬 ${(post.comments || 0) + (data.comments?.length || 0)} comments</span>
  </div>
  <div class="rpg-phone-reddit-comments-section">
    <h4>Comments</h4>
    <div style="display:flex;gap:6px;margin-bottom:12px;">
      <input type="text" class="rpg-phone-search-input" id="rpg_reddit_comment_input" placeholder="Add a comment as ${userName}…" style="margin:0;flex:1;font-size:0.85em;" />
      <button class="rpg-phone-btn-small" id="rpg_reddit_comment_btn" style="padding:4px 10px;">Post</button>
    </div>
    <div id="rpg_reddit_comments_list">${commentsHTML || '<p class="rpg-phone-muted">No comments yet.</p>'}</div>
  </div>
</div>`;

            const castVote = dir => {
                const ps3 = getPhoneState();
                if (!ps3 || !post.id) return;
                const cur = ps3.phoneVotes[post.id] || 0;
                ps3.phoneVotes[post.id] = cur === dir ? 0 : dir;
                savePhoneState();
                _logPhoneActivity('reddit', params.sub || 'r/all', 'out', `${dir === 1 ? 'Upvoted' : 'Downvoted'} post "${postTitle}"`);
                renderPost();
            };
            document.getElementById('rpg_post_up')?.addEventListener('click', () => castVote(1));
            document.getElementById('rpg_post_dn')?.addEventListener('click', () => castVote(-1));

            const submitComment = async () => {
                const inp = document.getElementById('rpg_reddit_comment_input');
                const commentText = inp?.value?.trim();
                if (!commentText) return;
                inp.value = '';

                const userComment = {
                    author: userName,
                    upvotes: 1,
                    text: commentText,
                    replies: [],
                };
                if (!data.comments) data.comments = [];
                data.comments.push(userComment);
                if (ps) {
                    ps.phoneCache[detailKey] = data;
                    _logPhoneActivity('reddit', params.sub || 'r/all', 'out', `Commented on "${postTitle}": "${commentText}"`);
                    savePhoneState();
                }
                renderPost();

                // Generate a simulated reply to user's comment asynchronously
                try {
                    const sceneCtx = _buildSceneContext(1000);
                    const sys = `You simulate a realistic Reddit commenter in a modern roleplay setting. Reply directly to this comment in 1-2 short sentences. Return ONLY the reply text, no quotes.`;
                    const usr = `${sceneCtx}\n\nSubreddit: ${params.sub || 'r/all'}\nPost: "${postTitle}"\n${userName} commented: "${commentText}"\nAnother redditor's reply:`;
                    const replyRaw = await sendPhoneRequest(sys, usr);
                    const replyText = (replyRaw || '').trim();
                    if (replyText) {
                        const randomAuthor = `u/user_${Math.floor(1000 + Math.random() * 9000)}`;
                        userComment.replies.push({
                            author: randomAuthor,
                            upvotes: Math.floor(1 + Math.random() * 5),
                            text: replyText,
                        });
                        if (ps) {
                            ps.phoneCache[detailKey] = data;
                            _logPhoneActivity('reddit', params.sub || 'r/all', 'in', `Reply from ${randomAuthor} on "${postTitle}": "${replyText}"`);
                            savePhoneState();
                        }
                        renderPost();
                    }
                } catch (e) {
                    console.warn('[Phone] Reddit reply simulation failed:', e);
                }
            };

            document.getElementById('rpg_reddit_comment_btn')?.addEventListener('click', submitComment);
            document.getElementById('rpg_reddit_comment_input')?.addEventListener('keydown', e => {
                if (e.key === 'Enter') submitComment();
            });

            _setRefreshAction(() => { if (ps) delete ps.phoneCache[detailKey]; _renderCurrentPage(); });
            _bindPhoneImages(screen);
        };
        renderPost();
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// APP STORE
// ─────────────────────────────────────────────────────────────────────────────

async function _renderAppStoreApp(pageId, params, screen) {
    _setNavTitle('App Store');
    const ps = getPhoneState();

    if (pageId === 'home') {
        const installed = (ps?.phoneApps || []);
        const installedHTML = installed.length
            ? installed.map(app => `
<div class="rpg-phone-appstore-installed" data-app-id="${_escHtml(app.id)}">
  <span class="rpg-phone-appstore-app-icon">${app.icon || '📱'}</span>
  <div>
    <div class="rpg-phone-appstore-app-name">${_escHtml(app.name)}</div>
    <div class="rpg-phone-appstore-app-desc">${_escHtml(app.description || '')}</div>
  </div>
  <button class="rpg-phone-btn-small rpg-phone-btn-danger rpg-phone-uninstall-btn" data-app-id="${_escHtml(app.id)}">Uninstall</button>
</div>`).join('')
            : '<p class="rpg-phone-muted">No apps installed yet.</p>';

        screen.innerHTML = `
<div class="rpg-phone-appstore">
  <div class="rpg-phone-appstore-hero">
    <h3>App Store</h3>
    <p class="rpg-phone-muted">Design and install AI-generated apps</p>
  </div>
  <button class="rpg-phone-btn rpg-phone-btn-primary" id="rpg_phone_install_app_btn">➕ Install New App</button>
  <div class="rpg-phone-appstore-installed-section">
    <h4>Installed Apps</h4>
    ${installedHTML}
  </div>
</div>`;

        document.getElementById('rpg_phone_install_app_btn')?.addEventListener('click', () => {
            _navigateTo('appstore', 'design');
        });
        screen.querySelectorAll('.rpg-phone-uninstall-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const id = btn.dataset.appId;
                if (ps) {
                    ps.phoneApps = ps.phoneApps.filter(a => a.id !== id);
                    savePhoneState();
                    _navigateTo('appstore', 'home');
                }
            });
        });
        return;
    }

    if (pageId === 'design') {
        _setNavTitle('Install App');
        screen.innerHTML = `
<div class="rpg-phone-appstore-design">
  <h3>Design Your App</h3>
  <p class="rpg-phone-muted">Describe the app you want to create. The AI will set up its dynamic prompt engine.</p>
  <div class="rpg-phone-appstore-field">
    <label for="rpg_phone_app_name">App Name (optional — AI will create one if empty):</label>
    <input type="text" class="rpg-phone-input-small" id="rpg_phone_app_name" placeholder="e.g. Tinder, CabNow, ShopHub, NewsDaily, CryptoWatch…"/>
  </div>
  <div class="rpg-phone-appstore-field">
    <label for="rpg_phone_app_icon">Icon Emoji (optional):</label>
    <input type="text" class="rpg-phone-input-small" id="rpg_phone_app_icon" placeholder="📱" maxlength="4"/>
  </div>
  <div class="rpg-phone-appstore-field">
    <label for="rpg_phone_app_desc">App Description & Purpose:</label>
    <textarea class="rpg-phone-textarea" id="rpg_phone_app_desc" rows="4" placeholder="e.g. A dating app to browse nearby profiles, swipe, and chat. Or a food delivery app with menus, orders, and delivery tracking…"></textarea>
  </div>
  <button class="rpg-phone-btn rpg-phone-btn-primary" id="rpg_phone_generate_app_btn">🔨 Create & Install App</button>
  <div id="rpg_phone_app_gen_status" class="rpg-phone-muted" style="margin-top:8px;"></div>
</div>`;

        document.getElementById('rpg_phone_generate_app_btn')?.addEventListener('click', async () => {
            const desc  = document.getElementById('rpg_phone_app_desc')?.value?.trim();
            const nameInput  = document.getElementById('rpg_phone_app_name')?.value?.trim();
            const iconInput  = document.getElementById('rpg_phone_app_icon')?.value?.trim();
            if (!desc && !nameInput) {
                alert('Please provide an app name or description.');
                return;
            }

            const statusEl = document.getElementById('rpg_phone_app_gen_status');
            if (statusEl) statusEl.textContent = '⚙️ Configuring app prompt engine…';
            const genBtn = document.getElementById('rpg_phone_generate_app_btn');
            if (genBtn) genBtn.disabled = true;

            await _generateAndInstallApp(nameInput, iconInput, desc || nameInput, statusEl);
        });
    }
}

async function _generateAndInstallApp(givenName, givenIcon, description, statusEl) {
    _markPhoneUsed();
    try {
        const sceneCtx = _buildSceneContext(1200);

        if (statusEl) statusEl.textContent = '🧠 Synthesizing app structure and prompts…';
        const sysBp = `You are a mobile operating system app architect. Create a configuration for a dynamic, prompt-driven smartphone app. Return ONLY valid JSON, no markdown fences, no prose.`;
        const usrBp = `## RECENT STORY EVENTS\n${sceneCtx}\n\nUser request:\nApp Name: ${givenName || '(choose an authentic, catchy name based on description)'}\nApp Icon: ${givenIcon || '(choose a single fitting emoji)'}\nDescription: ${description}\n\nGenerate the JSON specification for this app:\n{\n  "name": "${givenName || '<catchy app name>'}",\n  "icon": "${givenIcon || '<single emoji>'}",\n  "tagline": "<short 3-6 word slogan>",\n  "accentColor": "<hex color code, e.g. #6c63ff>",\n  "searchPlaceholder": "<e.g. Search products, profiles, news...>",\n  "categories": ["All", "Trending", "Nearby", "Favorites"],\n  "primaryActionLabel": "<e.g. Order, Message, Book, Like, View>",\n  "systemPrompt": "<instructions for generating realistic items/pages for this app in this roleplay world>"\n}`;

        const rawBp   = await sendPhoneRequest(sysBp, usrBp);
        const bpMatch = rawBp.match(/\{[\s\S]*\}/);
        let spec = {};
        if (bpMatch) {
            try { spec = JSON.parse(bpMatch[0]); } catch { }
        }

        // Determine final name and icon: explicitly prioritize user input if provided
        const finalName = (givenName || spec.name || 'Mobile App').trim();
        const finalIcon = (givenIcon || spec.icon || '📱').trim();
        const finalTagline = (spec.tagline || 'Modern Mobile Application').trim();
        const finalAccent = spec.accentColor || '#6c63ff';
        const finalCategories = Array.isArray(spec.categories) && spec.categories.length ? spec.categories : ['All', 'Trending', 'Nearby'];
        const finalSearchPh = spec.searchPlaceholder || `Search ${finalName}…`;
        const finalSysPrompt = spec.systemPrompt || `You simulate the mobile app "${finalName}" for a realistic modern roleplay setting.`;
        const finalActionLabel = spec.primaryActionLabel || 'Open';

        const ps = getPhoneState();
        if (!ps) throw new Error('No phone state');
        if (!Array.isArray(ps.phoneApps)) ps.phoneApps = [];

        const appId = `app_${Date.now()}`;
        ps.phoneApps.push({
            id                : appId,
            name              : finalName,
            icon              : finalIcon,
            description       : description,
            tagline           : finalTagline,
            accentColor       : finalAccent,
            searchPlaceholder : finalSearchPh,
            categories        : finalCategories,
            primaryActionLabel: finalActionLabel,
            systemPrompt      : finalSysPrompt,
            createdAt         : Date.now(),
        });

        // Record installation to phone history
        _logPhoneActivity('app', finalName, 'in', `Installed app "${finalName}" (${description || finalTagline})`);

        savePhoneState();

        if (statusEl) statusEl.textContent = `✅ "${finalName}" installed successfully!`;
        setTimeout(() => {
            _navigateHome();
        }, 1200);

    } catch (e) {
        if (statusEl) statusEl.textContent = `❌ Installation failed: ${e.message || String(e)}`;
        console.error('[Phone] App installation error:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT-DRIVEN INSTALLED APP RUNTIME
// ─────────────────────────────────────────────────────────────────────────────

async function _renderInstalledApp(appId, pageId, params = {}, screen) {
    _markPhoneUsed();
    const ps = getPhoneState();
    const app = ps?.phoneApps?.find(a => a.id === appId);
    if (!app) {
        screen.innerHTML = `<div class="rpg-phone-error">App not found.</div>`;
        return;
    }

    _setNavTitle(app.name);

    // ── 1. ITEM DETAIL SCREEN ────────────────────────────────────────────────
    if (pageId === 'detail') {
        const item = params.item || {};
        const itemId = item.id || params.itemId || 'item_1';
        const itemTitle = item.title || params.itemTitle || 'Details';
        _setNavTitle(itemTitle);

        const cacheKey = `app_detail_${appId}_${itemId}`;
        let detailData = ps?.phoneCache?.[cacheKey];

        if (!detailData) {
            try {
                const sceneCtx = _buildSceneContext(1000);
                const sys = `${app.systemPrompt || `You simulate the mobile app "${app.name}".`} Return ONLY valid JSON, no markdown fences.`;
                const usr = `## RECENT STORY EVENTS\n${sceneCtx}\n\nApp: "${app.name}" (${app.description || ''})\nItem Selected: "${itemTitle}"\nItem Context: ${JSON.stringify(item)}\n\nGenerate the complete, rich detail view for this item in ${app.name}:\n{\n  "title": "${itemTitle}",\n  "subtitle": "<status, category, or subheader>",\n  "imagePrompt": "<detailed visual description of photo if applicable, else empty>",\n  "body": "<2-3 paragraphs describing details, options, background, or narrative context>",\n  "stats": [\n    {"label":"<Stat/Key>","value":"<Value>"},\n    {"label":"<Stat/Key>","value":"<Value>"}\n  ],\n  "actions": [\n    {"id":"act_primary","label":"${app.primaryActionLabel || 'Interact'}","type":"primary"},\n    {"id":"act_secondary","label":"💬 Message / Inquiry","type":"secondary"}\n  ],\n  "reviews": [\n    {"user":"<username>","text":"<short feedback or review>"}\n  ]\n}`;

                const raw = await sendPhoneRequest(sys, usr);
                const match = raw.match(/\{[\s\S]*\}/);
                detailData = match ? JSON.parse(match[0]) : null;
                if (!detailData) throw new Error('Parse failed');
                if (ps) { ps.phoneCache[cacheKey] = detailData; savePhoneState(); }
            } catch (err) {
                screen.innerHTML = `<div class="rpg-phone-error">Could not load details.<br><small>${_escHtml(err.message || String(err))}</small></div>`;
                _setRefreshAction(() => { if (ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
                return;
            }
        }

        // Log viewing item details to phone context
        _logPhoneActivity('app', app.name, 'in', `Viewed "${itemTitle}" in ${app.name}: ${_summarizeText(detailData.body || detailData.subtitle, 160)}`);

        const statsHTML = (detailData.stats || []).map(s => `
<div class="rpg-phone-app-stat-box">
  <div class="rpg-phone-app-stat-label">${_escHtml(s.label || '')}</div>
  <div class="rpg-phone-app-stat-val">${_escHtml(s.value || '')}</div>
</div>`).join('');

        const actionsHTML = (detailData.actions || []).map(a => `
<button class="rpg-phone-app-btn-${a.type === 'secondary' ? 'secondary' : 'primary'}" data-action-id="${_escHtml(a.id)}" data-action-label="${_escHtml(a.label)}">${_escHtml(a.label)}</button>
`).join('');

        const reviewsHTML = (detailData.reviews || []).map(r => `
<div class="rpg-phone-app-review-item">
  <div class="rpg-phone-app-review-user">${_escHtml(r.user || 'User')}</div>
  <div class="rpg-phone-app-review-text">${_escHtml(r.text || '')}</div>
</div>`).join('');

        const imagePlaceholder = detailData.imagePrompt ? `[IMAGE: ${detailData.imagePrompt}]` : '';

        screen.innerHTML = `
<div class="rpg-phone-app-detail">
  <div class="rpg-phone-app-detail-header">
    <div class="rpg-phone-app-detail-title">${_escHtml(detailData.title || itemTitle)}</div>
    ${detailData.subtitle ? `<div class="rpg-phone-app-detail-subtitle">${_escHtml(detailData.subtitle)}</div>` : ''}
  </div>

  ${imagePlaceholder ? `<div>${_parsePhoneImages(imagePlaceholder)}</div>` : ''}

  ${statsHTML ? `<div class="rpg-phone-app-stats-grid">${statsHTML}</div>` : ''}

  <div class="rpg-phone-app-detail-body">${_parsePhoneImages(_escHtml(detailData.body || ''))}</div>

  <div class="rpg-phone-app-actions-row">
    ${actionsHTML}
  </div>

  <div class="rpg-phone-app-input-box">
    <input type="text" class="rpg-phone-app-input" id="rpg_phone_custom_action_input" placeholder="Type custom action or message…" />
    <button class="rpg-phone-btn-small rpg-phone-btn-primary" id="rpg_phone_custom_action_send">Send</button>
  </div>

  <div id="rpg_phone_custom_action_feedback" style="display:none;"></div>

  ${reviewsHTML ? `
  <div class="rpg-phone-app-reviews">
    <h5 style="margin:8px 0 4px;font-size:12px;opacity:0.6;">Activity & Feedback</h5>
    ${reviewsHTML}
  </div>` : ''}
</div>`;

        _bindPhoneImages(screen);
        _setRefreshAction(() => { if (ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });

        // Handle Action Buttons
        screen.querySelectorAll('[data-action-id]').forEach(btn => {
            btn.addEventListener('click', async () => {
                const actLabel = btn.dataset.actionLabel;
                await _executeCustomAppAction(app, itemTitle, actLabel, screen);
            });
        });

        // Handle Custom Text Action
        const sendCustom = async () => {
            const txt = document.getElementById('rpg_phone_custom_action_input')?.value?.trim();
            if (!txt) return;
            await _executeCustomAppAction(app, itemTitle, txt, screen);
        };
        document.getElementById('rpg_phone_custom_action_send')?.addEventListener('click', sendCustom);
        document.getElementById('rpg_phone_custom_action_input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') sendCustom();
        });

        return;
    }

    // ── 2. FEED / MAIN HOME SCREEN (pageId === 'home' or search/category) ───
    const activeCategory = params.category || 'All';
    const searchQuery = params.query || '';
    const cacheKey = `app_feed_${appId}_${activeCategory}_${searchQuery}`;

    let feedData = ps?.phoneCache?.[cacheKey];

    if (!feedData) {
        try {
            const sceneCtx = _buildSceneContext(1000);
            const sys = `${app.systemPrompt || `You simulate the mobile app "${app.name}".`} Return ONLY valid JSON, no markdown fences.`;
            const usr = `## RECENT STORY EVENTS\n${sceneCtx}\n\nApp: "${app.name}"\nDescription: ${app.description || ''}\nSelected Category: "${activeCategory}"\nSearch Filter: "${searchQuery || 'none'}"\n\nGenerate 4-6 dynamic, authentic items/cards for this app screen grounded in the story:\n{\n  "tagline": "${app.tagline || ''}",\n  "items": [\n    {\n      "id": "1",\n      "title": "<item / post / profile / product title>",\n      "subtitle": "<author, price, location, or tag>",\n      "badge": "<status tag or badge>",\n      "description": "<1-2 sentence preview or description>",\n      "metric": "<score, price, distance, or count>",\n      "imagePrompt": "<visual photo prompt if fitting, else empty>",\n      "actionText": "${app.primaryActionLabel || 'View'}"\n    }\n  ]\n}`;

            const raw = await sendPhoneRequest(sys, usr);
            const match = raw.match(/\{[\s\S]*\}/);
            feedData = match ? JSON.parse(match[0]) : null;
            if (!feedData || !Array.isArray(feedData.items)) throw new Error('Parse failed');
            if (ps) { ps.phoneCache[cacheKey] = feedData; savePhoneState(); }
        } catch (err) {
            screen.innerHTML = `<div class="rpg-phone-error">Could not load app content.<br><small>${_escHtml(err.message || String(err))}</small></div>`;
            _setRefreshAction(() => { if (ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });
            return;
        }
    }

    // Log opening app feed to phone activity
    _logPhoneActivity('app', app.name, 'in', `Opened ${app.name} (${activeCategory}) — Viewed: ${(feedData.items || []).slice(0, 3).map(i => i.title).join(', ')}`);

    const categories = app.categories || ['All', 'Trending', 'Nearby'];
    const tabsHTML = categories.map(cat => `
<div class="rpg-phone-app-tab${cat.toLowerCase() === activeCategory.toLowerCase() ? ' active' : ''}" data-category="${_escHtml(cat)}">${_escHtml(cat)}</div>
`).join('');

    const cardsHTML = (feedData.items || []).map((item, idx) => {
        const imagePlaceholder = item.imagePrompt ? `<div style="margin-top:6px;">${_parsePhoneImages(`[IMAGE: ${item.imagePrompt}]`)}</div>` : '';
        return `
<div class="rpg-phone-app-card" data-idx="${idx}" role="button" tabindex="0">
  <div class="rpg-phone-app-card-top">
    <div>
      <div class="rpg-phone-app-card-title">${_escHtml(item.title || 'Untitled')}</div>
      ${item.subtitle ? `<div class="rpg-phone-app-card-subtitle">${_escHtml(item.subtitle)}</div>` : ''}
    </div>
    ${item.badge ? `<span class="rpg-phone-app-card-badge">${_escHtml(item.badge)}</span>` : ''}
  </div>
  ${item.description ? `<div class="rpg-phone-app-card-desc">${_escHtml(item.description)}</div>` : ''}
  ${imagePlaceholder}
  <div class="rpg-phone-app-card-footer">
    <span class="rpg-phone-app-card-metric">${_escHtml(item.metric || '')}</span>
    <span class="rpg-phone-app-card-action">${_escHtml(item.actionText || 'View ›')}</span>
  </div>
</div>`;
    }).join('');

    screen.innerHTML = `
<div class="rpg-phone-custom-app">
  <div class="rpg-phone-app-banner">
    <div class="rpg-phone-app-header-left">
      <span class="rpg-phone-app-header-icon">${app.icon || '📱'}</span>
      <div>
        <div class="rpg-phone-app-header-title">${_escHtml(app.name)}</div>
        <div class="rpg-phone-app-header-tagline">${_escHtml(feedData.tagline || app.tagline || '')}</div>
      </div>
    </div>
  </div>

  <div class="rpg-phone-app-search-wrap">
    <input type="text" class="rpg-phone-app-search-input" id="rpg_phone_custom_search" placeholder="${_escHtml(app.searchPlaceholder || 'Search…')}" value="${_escHtml(searchQuery)}"/>
  </div>

  <div class="rpg-phone-app-tabs">
    ${tabsHTML}
  </div>

  <div class="rpg-phone-app-feed">
    ${cardsHTML || '<p class="rpg-phone-muted" style="text-align:center;padding:24px;">No items found.</p>'}
  </div>
</div>`;

    _bindPhoneImages(screen);
    _setRefreshAction(() => { if (ps) delete ps.phoneCache[cacheKey]; _renderCurrentPage(); });

    // Tab clicks
    screen.querySelectorAll('.rpg-phone-app-tab').forEach(tabEl => {
        tabEl.addEventListener('click', () => {
            const cat = tabEl.dataset.category;
            _navigateTo(`installed_${appId}`, 'home', { appId, category: cat, query: searchQuery });
        });
    });

    // Search input
    const doSearch = () => {
        const q = document.getElementById('rpg_phone_custom_search')?.value?.trim();
        _navigateTo(`installed_${appId}`, 'home', { appId, category: activeCategory, query: q });
    };
    document.getElementById('rpg_phone_custom_search')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') doSearch();
    });

    // Card clicks
    screen.querySelectorAll('.rpg-phone-app-card').forEach(cardEl => {
        cardEl.addEventListener('click', ev => {
            if (ev.target.closest('.rpg-phone-image-placeholder')) return;
            const idx = parseInt(cardEl.dataset.idx, 10);
            const selectedItem = feedData.items?.[idx];
            if (selectedItem) {
                _navigateTo(`installed_${appId}`, 'detail', { appId, item: selectedItem, itemId: selectedItem.id, itemTitle: selectedItem.title });
            }
        });
    });
}

async function _executeCustomAppAction(app, itemTitle, actionText, screen) {
    const feedbackBox = document.getElementById('rpg_phone_custom_action_feedback');
    if (feedbackBox) {
        feedbackBox.style.display = 'block';
        feedbackBox.className = 'rpg-phone-app-feedback-box';
        feedbackBox.textContent = '⏳ Processing action…';
    }

    try {
        const sceneCtx = _buildSceneContext(800);
        const sys = `You simulate the backend/AI response of the mobile app "${app.name}". Respond in 1-2 realistic sentences confirming the action or describing the in-app outcome. Return ONLY the response text, no quotes.`;
        const usr = `## RECENT STORY EVENTS\n${sceneCtx}\n\nApp: "${app.name}"\nItem: "${itemTitle}"\nUser Action: "${actionText}"\nWhat happens in the app:`;

        const reply = (await sendPhoneRequest(sys, usr))?.trim() || 'Action completed successfully.';

        if (feedbackBox) {
            feedbackBox.textContent = `✓ ${reply}`;
        }

        // Record to phone history via universal logger
        _logPhoneActivity('app', app.name, 'out', `[${app.name}] ${actionText} on "${itemTitle}": ${reply}`);
    } catch (e) {
        if (feedbackBox) {
            feedbackBox.textContent = `❌ Action error: ${e.message || String(e)}`;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGES (SMS) APP
// ─────────────────────────────────────────────────────────────────────────────

function _renderMessagesApp(pageId, params, screen) {
    _setNavTitle('Messages');
    const ps = getPhoneState();

    if (pageId === 'home') {
        // Clear unread messages badge
        if (ps) { ps.phoneUnread.messages = 0; savePhoneState(); _updateNotificationBadge(); }

        const threads = Object.entries(ps?.phoneMessages || {});
        const threadHTML = threads.length ? threads.map(([contact, msgs]) => {
            const last = msgs[msgs.length - 1];
            return `
<div class="rpg-phone-sms-thread-row" data-contact="${_escHtml(contact)}" role="button" tabindex="0">
  <div class="rpg-phone-sms-avatar">${contact[0]?.toUpperCase() || '?'}</div>
  <div class="rpg-phone-sms-thread-info">
    <div class="rpg-phone-sms-contact-name">${_escHtml(contact)}</div>
    <div class="rpg-phone-sms-last-msg">${_escHtml((last?.text || '').slice(0, 50))}${(last?.text || '').length > 50 ? '…' : ''}</div>
  </div>
</div>`;
        }).join('') : '<p class="rpg-phone-muted" style="padding:16px;">No messages yet.</p>';

        screen.innerHTML = `
<div class="rpg-phone-messages-header">
  <h3>Messages</h3>
  <button class="rpg-phone-btn-small" id="rpg_phone_new_msg_btn">✏️ New</button>
</div>
<div class="rpg-phone-sms-list">${threadHTML}</div>`;

        screen.querySelectorAll('.rpg-phone-sms-thread-row').forEach(el => {
            el.addEventListener('click', () => _navigateTo('messages', 'thread', { contact: el.dataset.contact }));
        });
        document.getElementById('rpg_phone_new_msg_btn')?.addEventListener('click', () => {
            _navigateTo('contacts', 'home', { selectForMessage: true });
        });
        return;
    }

    if (pageId === 'thread') {
        const contact = params.contact || 'Unknown';
        _setNavTitle(contact);
        const msgs = (ps?.phoneMessages?.[contact] || []);

        if (msgs.length) {
            _logPhoneActivity('sms', contact, 'in', `Read SMS conversation with ${contact} (Last: "${_summarizeText(msgs[msgs.length - 1]?.text, 80)}")`);
        }

        const bubblesHTML = msgs.map(m => `
<div class="rpg-phone-sms-bubble ${m.direction === 'out' ? 'rpg-phone-sms-out' : 'rpg-phone-sms-in'}">
  ${_parsePhoneImages(_escHtml(m.text || ''))}
</div>`).join('');

        screen.innerHTML = `
<div class="rpg-phone-sms-thread">
  <div class="rpg-phone-sms-bubbles" id="rpg_phone_sms_bubbles">
    ${bubblesHTML || '<p class="rpg-phone-muted" style="text-align:center;padding:20px;">Start a conversation</p>'}
  </div>
  <div class="rpg-phone-sms-compose">
    <input type="text" class="rpg-phone-sms-input" id="rpg_phone_sms_input" placeholder="Message…" autocomplete="off"/>
    <button class="rpg-phone-sms-send-btn" id="rpg_phone_sms_send">▶</button>
  </div>
</div>`;

        // Scroll to bottom
        const bubbles = document.getElementById('rpg_phone_sms_bubbles');
        if (bubbles) bubbles.scrollTop = bubbles.scrollHeight;
        _bindPhoneImages(screen);

        const sendMsg = async () => {
            const input = document.getElementById('rpg_phone_sms_input');
            const text = input?.value?.trim();
            if (!text || !input) return;
            input.value = '';
            _markPhoneUsed();

            // Add outgoing bubble
            const outBubble = document.createElement('div');
            outBubble.className = 'rpg-phone-sms-bubble rpg-phone-sms-out';
            outBubble.innerHTML = _parsePhoneImages(_escHtml(text));
            bubbles?.appendChild(outBubble);
            bubbles && (bubbles.scrollTop = bubbles.scrollHeight);
            _bindPhoneImages(screen);

            const timeInfo = getInWorldTimeInfo();

            if (!ps.phoneMessages[contact]) ps.phoneMessages[contact] = [];
            ps.phoneMessages[contact].push({
                text,
                direction     : 'out',
                timestamp     : Date.now(),
                inWorldMinutes: timeInfo.totalMinutes,
                inWorldTimeStr: timeInfo.clockOnly || timeInfo.rawTime,
            });

            // Log to phone history via universal logger
            _logPhoneActivity('sms', contact, 'out', text);
            savePhoneState();

            // AI reply
            try {
                const ctx = await _buildNpcCallContext(contact);

                const sys = `You are roleplaying as ${contact} in a text message conversation with ${ctx.pcName}.

${ctx.cardBlock ? `## WORLD & ACTIVE CARD CONTEXT\n${ctx.cardBlock}\n\n` : ''}${ctx.npcBlock ? `## WHO YOU ARE\n${ctx.npcBlock}\n\n` : ''}${ctx.pcBlock ? `## WHO YOU ARE TALKING TO (${ctx.pcName})\n${ctx.pcBlock}\n\n` : ''}## RULES
- Stay fully in character as ${contact}. Speak how this character would actually speak.
- You ONLY know what ${contact} would realistically know. Do NOT reference events, places, or information ${contact} hasn't been told about in the story.
- Do NOT mention game stats, HP, combat mechanics, gear lists, or anything meta.
- This is a TEXT MESSAGE — keep it casual and natural. 1–3 short sentences max.
- If you send a photo, include [IMAGE: detailed visual description of the photo] in your text.
- Reply with ONLY the message text. No labels, no quotes around the whole thing.`;

                const usr = `${ctx.chatContext ? ctx.chatContext + '\n\n' : ''}${ctx.threadHistory ? '## CONVERSATION SO FAR\n' + ctx.threadHistory + '\n\n' : ''}${ctx.pcName} just texted: "${text}"
${contact} replies:`;

                const reply = await sendPhoneRequest(sys, usr);
                const replyText = reply.trim();

                const replyTimeInfo = getInWorldTimeInfo();

                ps.phoneMessages[contact].push({
                    text          : replyText,
                    direction     : 'in',
                    timestamp     : Date.now(),
                    inWorldMinutes: replyTimeInfo.totalMinutes,
                    inWorldTimeStr: replyTimeInfo.clockOnly || replyTimeInfo.rawTime,
                });
                _logPhoneActivity('sms', contact, 'in', replyText);
                savePhoneState();

                const inBubble = document.createElement('div');
                inBubble.className = 'rpg-phone-sms-bubble rpg-phone-sms-in';
                inBubble.innerHTML = _parsePhoneImages(_escHtml(replyText));
                bubbles?.appendChild(inBubble);
                bubbles && (bubbles.scrollTop = bubbles.scrollHeight);
                _bindPhoneImages(screen);
            } catch (e) {
                console.warn('[Phone] SMS reply failed:', e);
            }
        };

        document.getElementById('rpg_phone_sms_send')?.addEventListener('click', sendMsg);
        document.getElementById('rpg_phone_sms_input')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') sendMsg();
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DIALER APP
// ─────────────────────────────────────────────────────────────────────────────

function _renderDialerApp(pageId, params, screen) {
    _setNavTitle('Phone');
    const ps = getPhoneState();

    if (ps) { ps.phoneUnread.calls = 0; savePhoneState(); _updateNotificationBadge(); }

    if (pageId === 'home') {
        const recentCalls = (ps?.phoneCallLog || []).slice(-5).reverse();
        const callLogHTML = recentCalls.length ? recentCalls.map(c => `
<div class="rpg-phone-calllog-row" data-contact="${_escHtml(c.name)}" role="button" tabindex="0">
  <span class="rpg-phone-calllog-dir">${c.direction === 'out' ? '📤' : (c.direction === 'missed' ? '📵' : '📥')}</span>
  <div class="rpg-phone-calllog-info">
    <div class="rpg-phone-calllog-name">${_escHtml(c.name)}</div>
    <div class="rpg-phone-calllog-meta">${c.duration || ''}</div>
  </div>
  <button class="rpg-phone-btn-small rpg-phone-call-back-btn" data-contact="${_escHtml(c.name)}">📞</button>
</div>`).join('') : '<p class="rpg-phone-muted" style="padding:8px;">No recent calls.</p>';

        screen.innerHTML = `
<div class="rpg-phone-dialer">
  <div class="rpg-phone-dialer-display" id="rpg_phone_dialer_display"></div>
  <div class="rpg-phone-dialer-grid">
    ${['1','2','3','4','5','6','7','8','9','*','0','#'].map(k =>
        `<button class="rpg-phone-dialpad-key" data-key="${k}">${k}</button>`).join('')}
  </div>
  <div class="rpg-phone-dialer-actions">
    <button class="rpg-phone-call-btn" id="rpg_phone_dial_call">📞</button>
    <button class="rpg-phone-delete-btn" id="rpg_phone_dial_del">⌫</button>
  </div>
  <div class="rpg-phone-calllog">
    <h4>Recent</h4>
    ${callLogHTML}
  </div>
</div>`;

        const display = document.getElementById('rpg_phone_dialer_display');
        screen.querySelectorAll('.rpg-phone-dialpad-key').forEach(btn => {
            btn.addEventListener('click', () => {
                if (display) display.textContent += btn.dataset.key;
            });
        });
        document.getElementById('rpg_phone_dial_del')?.addEventListener('click', () => {
            if (display) display.textContent = display.textContent.slice(0, -1);
        });
        document.getElementById('rpg_phone_dial_call')?.addEventListener('click', () => {
            const num = display?.textContent || '';
            _navigateTo('dialer', 'call', { contact: num || 'Unknown' });
        });
        screen.querySelectorAll('.rpg-phone-call-back-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                _navigateTo('dialer', 'call', { contact: btn.dataset.contact });
            });
        });
        return;
    }

    if (pageId === 'call') {
        const contact = params.contact || 'Unknown';
        _setNavTitle(`Calling ${contact}…`);
        _markPhoneUsed();

        let callSeconds = 0;
        let timerInterval = null;
        let callEnded = false;

        screen.innerHTML = `
<div class="rpg-phone-call-screen">
  <div class="rpg-phone-call-avatar">${contact[0]?.toUpperCase() || '?'}</div>
  <div class="rpg-phone-call-name">${_escHtml(contact)}</div>
  <div class="rpg-phone-call-status" id="rpg_phone_call_status">Connecting…</div>
  <div class="rpg-phone-call-timer" id="rpg_phone_call_timer">0:00</div>
  <div class="rpg-phone-call-transcript" id="rpg_phone_call_transcript"></div>
  <div class="rpg-phone-call-controls">
    <button class="rpg-phone-call-control-btn" id="rpg_phone_call_mute">🔇</button>
    <button class="rpg-phone-call-end-btn" id="rpg_phone_call_end">🔴</button>
    <button class="rpg-phone-call-control-btn" id="rpg_phone_call_speaker">🔊</button>
  </div>
  <div class="rpg-phone-call-input-row" id="rpg_phone_call_input_row" style="display:none;">
    <input type="text" class="rpg-phone-sms-input" id="rpg_phone_call_say" placeholder="Say something…"/>
    <button class="rpg-phone-sms-send-btn" id="rpg_phone_call_say_btn">▶</button>
  </div>
</div>`;

        const statusEl     = document.getElementById('rpg_phone_call_status');
        const timerEl      = document.getElementById('rpg_phone_call_timer');
        const transcriptEl = document.getElementById('rpg_phone_call_transcript');
        const inputRow     = document.getElementById('rpg_phone_call_input_row');

        // Simulate call connecting after 1.5s
        setTimeout(async () => {
            if (callEnded) return;
            if (statusEl) statusEl.textContent = 'Connected';
            if (inputRow) inputRow.style.display = 'flex';
            timerInterval = setInterval(() => {
                callSeconds++;
                const m = Math.floor(callSeconds / 60);
                const s2 = callSeconds % 60;
                if (timerEl) timerEl.textContent = `${m}:${String(s2).padStart(2, '0')}`;
            }, 1000);

            // Initial greeting from the NPC
            try {
                const ctx = await _buildNpcCallContext(contact);
                const sys = `You are roleplaying as ${contact} answering a phone call from ${ctx.pcName}.

${ctx.cardBlock ? `## WORLD & ACTIVE CARD CONTEXT\n${ctx.cardBlock}\n\n` : ''}${ctx.npcBlock ? `## WHO YOU ARE\n${ctx.npcBlock}\n\n` : ''}${ctx.pcBlock ? `## WHO YOU ARE TALKING TO (${ctx.pcName})\n${ctx.pcBlock}\n\n` : ''}## RULES
- Stay fully in character as ${contact}. Speak how this character would actually speak — their tone, vocabulary, and personality.
- You ONLY know what ${contact} would realistically know. Never reference anything ${contact} hasn't been told.
- Do NOT mention game mechanics, stats, HP, combat info, or anything meta.
- This is a SPOKEN phone call — speak naturally. 1–2 sentences max per turn.
- Output ONLY the spoken words. No dialogue tags, no asterisks, no quotes.`;

                const usr = `${ctx.chatContext ? ctx.chatContext + '\n\n' : ''}*${contact}'s phone rings. ${contact} picks up.*
${contact} says:`;

                const greeting = await sendPhoneRequest(sys, usr);
                const greetingText = greeting.trim();

                if (transcriptEl && !callEnded) {
                    const line = document.createElement('div');
                    line.className = 'rpg-phone-call-line rpg-phone-call-npc';
                    line.textContent = `${contact}: ${greetingText}`;
                    transcriptEl.appendChild(line);
                }
            } catch (e) {
                console.warn('[Phone] Call greeting failed:', e);
            }
        }, 1500);

        const saySomething = async () => {
            const input = document.getElementById('rpg_phone_call_say');
            const text = input?.value?.trim();
            if (!text || !input || callEnded) return;
            input.value = '';

            const { pcName } = _getPlayerCharacterInfo();
            // User line
            const userLine = document.createElement('div');
            userLine.className = 'rpg-phone-call-line rpg-phone-call-user';
            userLine.textContent = `${pcName}: ${text}`;
            transcriptEl?.appendChild(userLine);
            transcriptEl && (transcriptEl.scrollTop = transcriptEl.scrollHeight);

            // NPC response
            try {
                const ctx = await _buildNpcCallContext(contact);
                const allLines = Array.from(transcriptEl?.children || []).map(el => el.textContent).join('\n');
                const sys = `You are roleplaying as ${contact} on a phone call with ${ctx.pcName}.

${ctx.cardBlock ? `## WORLD & ACTIVE CARD CONTEXT\n${ctx.cardBlock}\n\n` : ''}${ctx.npcBlock ? `## WHO YOU ARE\n${ctx.npcBlock}\n\n` : ''}${ctx.pcBlock ? `## WHO YOU ARE TALKING TO (${ctx.pcName})\n${ctx.pcBlock}\n\n` : ''}## RULES
- Stay fully in character as ${contact}. Speak naturally in 1–2 sentences.
- You ONLY know what ${contact} realistically knows from the story.
- Output ONLY spoken dialogue. No tags, no actions, no asterisks, no quotes.`;

                const usr = `${ctx.chatContext ? ctx.chatContext + '\n\n' : ''}## CALL TRANSCRIPT SO FAR\n${allLines}\n\n${contact} says:`;

                const reply = await sendPhoneRequest(sys, usr);
                const replyText = reply.trim();

                if (transcriptEl && !callEnded) {
                    const line = document.createElement('div');
                    line.className = 'rpg-phone-call-line rpg-phone-call-npc';
                    line.textContent = `${contact}: ${replyText}`;
                    transcriptEl.appendChild(line);
                    transcriptEl.scrollTop = transcriptEl.scrollHeight;
                }
            } catch (e) {
                console.warn('[Phone] Call reply failed:', e);
            }
        };

        document.getElementById('rpg_phone_call_say_btn')?.addEventListener('click', saySomething);
        document.getElementById('rpg_phone_call_say')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') saySomething();
        });

        document.getElementById('rpg_phone_call_end')?.addEventListener('click', () => {
            callEnded = true;
            clearInterval(timerInterval);
            const dur = `${Math.floor(callSeconds / 60)}:${String(callSeconds % 60).padStart(2, '0')}`;
            if (statusEl) statusEl.textContent = 'Call ended';
            if (inputRow) inputRow.style.display = 'none';

            // Collect full transcript
            const transcriptNodes = Array.from(transcriptEl?.children || []);
            const transcriptLines = transcriptNodes.map(el => el.textContent.trim()).filter(Boolean);
            const callSummary = transcriptLines.length > 0
                ? `Call with ${contact} (${dur}) — Dialogue: ${transcriptLines.join(' | ')}`
                : `Call with ${contact} (${dur})`;

            // Log to call log and phone history via universal logger
            const ps2 = getPhoneState();
            if (ps2) {
                const timeInfo = getInWorldTimeInfo();

                if (!Array.isArray(ps2.phoneCallLog)) ps2.phoneCallLog = [];
                ps2.phoneCallLog.push({
                    name          : contact,
                    duration      : dur,
                    direction     : 'out',
                    timestamp     : Date.now(),
                    inWorldMinutes: timeInfo.totalMinutes,
                    inWorldTimeStr: timeInfo.clockOnly || timeInfo.rawTime,
                    transcript    : transcriptLines,
                });
                if (ps2.phoneCallLog.length > 100) ps2.phoneCallLog.splice(0, ps2.phoneCallLog.length - 100);
                _logPhoneActivity('call', contact, 'out', callSummary);
                savePhoneState();
            }
            setTimeout(() => _navigateBack(), 1500);
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// NPC CONTEXT BUILDER — shared by SMS + Calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds rich context for an NPC phone interaction.
 * - NPC info: searches the current campaign's `_NPCs` lorebook and character cards.
 * - Auto keyword activation: activates matching lorebook entry into `keywordActivatedKeys`.
 * - Story context: full chat history, trimmed to fit the player's context window.
 * - Thread history: existing SMS thread (for SMS calls).
 * @param {string} contact  Display name of the NPC
 * @returns {Promise<{ pcName: string, pcBio: string, pcBlock: string, npcBlock: string, chatContext: string, threadHistory: string }>}
 */
async function _buildNpcCallContext(contact) {
    const settings  = getSettings();
    const stContext = SillyTavern.getContext?.() || {};
    const { pcName, pcBio, pcBlock } = _getPlayerCharacterInfo();

    // ── NPC lorebook entry & auto keyword trigger ─────────────────────────────
    let npcBlock = '';
    try {
        if (stContext?.loadWorldInfo && contact) {
            const chatId = getActiveChatId() || stContext.chatId || '';
            const prefix = getEffectiveRouterCampaignPrefix(chatId);

            // Prioritized book candidates
            const candidateBooks = [];
            if (prefix) candidateBooks.push(`${prefix}_NPCs`);
            candidateBooks.push('NPCs');
            if (chatId && chatId !== prefix) candidateBooks.push(`${chatId}_NPCs`);

            // Also inspect ST world info books ending in _NPCs or belonging to this prefix
            try {
                const allBooks = Array.isArray(stContext.world_info) ? stContext.world_info : (await stContext.loadWorldInfoList?.() || []);
                for (const b of allBooks) {
                    if (typeof b === 'string' && (b.endsWith('_NPCs') || (prefix && b.toLowerCase().startsWith(`${prefix.toLowerCase()}_`)))) {
                        if (!candidateBooks.includes(b)) candidateBooks.push(b);
                    }
                }
            } catch (_) {}

            // Also check books already in active keys
            const activeKeys = [...new Set([
                ...(settings.activeRouterKeys     || []),
                ...(settings.keywordActivatedKeys || []),
                ...(settings.activeWorldKeys      || []),
            ])];
            for (const k of activeKeys) {
                const [bName] = String(k).split('::');
                if (bName && !candidateBooks.includes(bName)) candidateBooks.push(bName);
            }

            const cleanContact = contact.toLowerCase().trim();
            const contactWords = cleanContact.split(/\s+/).filter(Boolean);

            let matchedEntry = null;
            let matchedBookName = '';
            let matchedUid = '';

            for (const bookName of candidateBooks) {
                try {
                    const book = await stContext.loadWorldInfo(bookName);
                    if (!book?.entries) continue;

                    for (const [uid, entry] of Object.entries(book.entries)) {
                        if (!entry?.content) continue;
                        const title = (entry.comment || '').replace(/^\[.*?\]\s*/i, '').toLowerCase().trim();
                        const keys = Array.isArray(entry.key) ? entry.key.map(k => String(k).toLowerCase().trim()) : [];

                        // 1. Title match (exact or partial)
                        const titleMatch = title === cleanContact ||
                                           title.includes(cleanContact) ||
                                           cleanContact.includes(title) ||
                                           contactWords.some(w => w.length > 2 && title.split(/\s+/).includes(w));

                        // 2. Keyword match
                        const keyMatch = keys.some(k => k === cleanContact || cleanContact.includes(k) || k.includes(cleanContact));

                        if (titleMatch || keyMatch) {
                            matchedEntry = entry;
                            matchedBookName = bookName;
                            matchedUid = uid;
                            break;
                        }
                    }
                    if (matchedEntry) break;
                } catch (_) {}
            }

            if (matchedEntry) {
                npcBlock = String(matchedEntry.content).trim();
                const loreKey = `${matchedBookName}::${matchedUid}`;

                // Trigger keyword activation into keywordActivatedKeys so it remains active in campaign
                if (!Array.isArray(settings.keywordActivatedKeys)) {
                    settings.keywordActivatedKeys = [];
                }
                if (!settings.keywordActivatedKeys.includes(loreKey)) {
                    settings.keywordActivatedKeys.push(loreKey);
                    console.log(`[Phone] Keyword activated lorebook entry for "${contact}": ${loreKey}`);
                    try {
                        saveChatState(chatId);
                    } catch (_) {}
                }
            }
        }
    } catch (e) {
        console.warn('[Phone] NPC lore lookup / keyword activation failed:', e);
    }

    // Fallback to ST character cards if not found in lorebook
    if (!npcBlock && stContext?.characters) {
        try {
            const cleanContact = contact.toLowerCase().trim();
            for (const char of Object.values(stContext.characters)) {
                if (!char?.name) continue;
                const charName = char.name.toLowerCase().trim();
                if (charName === cleanContact || cleanContact.includes(charName) || charName.includes(cleanContact)) {
                    const parts = [];
                    if (char.description) parts.push(`Description:\n${char.description}`);
                    if (char.personality) parts.push(`Personality:\n${char.personality}`);
                    if (char.mes_example) parts.push(`Example Dialogue:\n${char.mes_example}`);
                    npcBlock = parts.join('\n\n');
                    break;
                }
            }
        } catch (_) {}
    }

    // ── Active Card / World Context ───────────────────────────────────────────
    let cardBlock = '';
    if (settings.phoneIncludeCardContext !== false) {
        const cardInfo = _getActiveCardInfo();
        if (cardInfo?.cardBlock) {
            cardBlock = cardInfo.cardBlock;
        }
    }

    // ── Chat history, sized to player's actual context window ────────────────
    const contextSize  = stContext?.contextSize || 8192;
    const promptOverhead = 2000 + Math.ceil(((cardBlock?.length || 0) + (npcBlock?.length || 0) + (pcBlock?.length || 0)) / 3.5);
    const charBudget   = Math.floor((contextSize - promptOverhead) * 3.5);

    let chatContext = '';
    const chat = stContext?.chat;
    if (Array.isArray(chat) && chat.length) {
        const lines = [];
        let usedChars = 0;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            const raw = String(m.mes || m.content || '').trim();
            const text = cleanToolCallMessage(raw);
            if (!text) continue;
            const name = m.is_user ? pcName : (m.name || 'Narrator');
            const line = `${name}: ${text}`;
            if (usedChars + line.length > charBudget) break;
            lines.unshift(line);
            usedChars += line.length + 1;
        }
        if (lines.length) chatContext = lines.join('\n\n');
    }

    // ── Existing SMS thread ───────────────────────────────────────────────────
    const ps = getPhoneState();
    let threadHistory = '';
    const thread = ps?.phoneMessages?.[contact];
    if (Array.isArray(thread) && thread.length) {
        threadHistory = thread.map(m => {
            const who = m.direction === 'out' ? pcName : contact;
            return `${who}: ${m.text}`;
        }).join('\n');
    }

    return { pcName, pcBio, pcBlock, cardBlock, npcBlock, chatContext, threadHistory };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACTS APP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads NPCs strictly from the current chat's Lorebook Agent `_NPCs` book.
 * @returns {Promise<Array<{ name: string, relation: string, uid: string, content: string }>>}
 */
async function _getChatLorebookNpcs() {
    try {
        const ctx = SillyTavern.getContext?.() || {};
        const chatId = getActiveChatId() || ctx.chatId || '';
        const prefix = getEffectiveRouterCampaignPrefix(chatId);

        const candidates = [];
        if (prefix) {
            candidates.push(`${prefix}_NPCs`);
        }
        candidates.push('NPCs');
        if (chatId && chatId !== prefix) {
            candidates.push(`${chatId}_NPCs`);
        }

        // Also check if any loaded book in ST matches this prefix and ends with _NPCs
        try {
            const allBooks = Array.isArray(ctx.world_info) ? ctx.world_info : (await ctx.loadWorldInfoList?.() || []);
            for (const bName of allBooks) {
                if (typeof bName === 'string' && bName.endsWith('_NPCs')) {
                    if (prefix && bName.toLowerCase().startsWith(`${prefix.toLowerCase()}_`)) {
                        if (!candidates.includes(bName)) candidates.unshift(bName);
                    } else if (!candidates.includes(bName)) {
                        candidates.push(bName);
                    }
                }
            }
        } catch (_) {}

        const npcs = [];
        const seen = new Set();

        // 1. Lorebook Agent _NPCs entries
        for (const bookName of candidates) {
            try {
                const book = await ctx.loadWorldInfo(bookName);
                if (book && book.entries) {
                    for (const [uid, entry] of Object.entries(book.entries)) {
                        if (!entry) continue;
                        const rawName = (entry.comment || entry.key?.[0] || '').trim();
                        // Strip bracket markers like [NPC]
                        const cleanName = rawName.replace(/^\[.*?\]\s*/i, '').trim();
                        if (cleanName && !seen.has(cleanName.toLowerCase())) {
                            seen.add(cleanName.toLowerCase());

                            let shortTag = '';
                            if (entry.content) {
                                const tagMatch = entry.content.match(/(?:Role|Relation|Occupation|Title|Status):\s*([^\n\r.]+)/i);
                                if (tagMatch) shortTag = tagMatch[1].trim();
                            }

                            npcs.push({
                                name: cleanName,
                                relation: shortTag,
                                uid: uid,
                                content: entry.content || ''
                            });
                        }
                    }
                }
            } catch (_) {}
            // If primary campaign NPC book found entries, stop to avoid pulling other campaign books
            if (npcs.length > 0 && prefix && candidates[0] === `${prefix}_NPCs`) {
                break;
            }
        }

        // 2. Also include main character card name in chat if not player
        const currentChatChar = ctx.characters?.[ctx.characterId]?.name;
        const pcName = _getPlayerCharacterInfo()?.pcName || '';
        if (currentChatChar && currentChatChar.toLowerCase() !== pcName.toLowerCase() && !seen.has(currentChatChar.toLowerCase())) {
            npcs.unshift({
                name: currentChatChar,
                relation: 'Character Card',
                uid: 'char_main',
                content: ''
            });
            seen.add(currentChatChar.toLowerCase());
        }

        return npcs;
    } catch (e) {
        console.warn('[Phone] Error loading chat lorebook NPCs:', e);
        return [];
    }
}

async function _renderContactsApp(pageId, params, screen) {
    _setNavTitle('Contacts');
    const ps = getPhoneState();

    if (pageId === 'home') {
        const contacts = (ps?.phoneContacts || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        const listHTML = contacts.length ? contacts.map(c => `
<div class="rpg-phone-contact-row" data-contact="${_escHtml(c.name)}" role="button" tabindex="0">
  <div class="rpg-phone-contact-avatar">${c.name[0]?.toUpperCase() || '?'}</div>
  <div class="rpg-phone-contact-info">
    <div class="rpg-phone-contact-name">${_escHtml(c.name)}</div>
    ${c.relation ? `<div class="rpg-phone-contact-relation rpg-phone-muted">${_escHtml(c.relation)}</div>` : ''}
  </div>
</div>`).join('') : '<p class="rpg-phone-muted" style="padding:16px 0;text-align:center;">No contacts saved yet.</p>';

        const selectMode = params?.selectForMessage;
        screen.innerHTML = `
<div class="rpg-phone-contacts">
  <div class="rpg-phone-contacts-header">
    <input type="text" class="rpg-phone-search-input" id="rpg_phone_contact_search" placeholder="Search contacts…"/>
  </div>
  <button class="rpg-phone-btn rpg-phone-btn-secondary" id="rpg_phone_add_contact_btn" style="margin-bottom:12px;">➕ Add Contact</button>
  <div class="rpg-phone-contact-list" id="rpg_phone_contact_list">${listHTML}</div>
</div>`;

        screen.querySelectorAll('.rpg-phone-contact-row').forEach(el => {
            el.addEventListener('click', () => {
                if (selectMode) {
                    _navigateTo('messages', 'thread', { contact: el.dataset.contact });
                } else {
                    _navigateTo('contacts', 'detail', { contact: el.dataset.contact });
                }
            });
        });

        screen.querySelector('#rpg_phone_contact_search')?.addEventListener('input', e => {
            const q = e.target.value.toLowerCase().trim();
            screen.querySelectorAll('.rpg-phone-contact-row').forEach(row => {
                row.style.display = row.dataset.contact.toLowerCase().includes(q) ? '' : 'none';
            });
        });

        screen.querySelector('#rpg_phone_add_contact_btn')?.addEventListener('click', () => {
            _navigateTo('contacts', 'add');
        });
        return;
    }

    if (pageId === 'detail') {
        const contact = params.contact || '';
        _setNavTitle(contact);
        const c = ps?.phoneContacts?.find(x => x.name === contact) || { name: contact };
        const relInfo = (getSettings().npcRelationshipValues || {})[contact];
        const relMax  = getSettings().npcRelationshipMax || 150;

        screen.innerHTML = `
<div class="rpg-phone-contact-detail">
  <div class="rpg-phone-contact-detail-avatar">${contact[0]?.toUpperCase() || '?'}</div>
  <h3 class="rpg-phone-contact-detail-name">${_escHtml(contact)}</h3>
  ${c.relation ? `<p class="rpg-phone-muted" style="margin-top:-4px;">${_escHtml(c.relation)}</p>` : ''}
  ${relInfo ? `<div class="rpg-phone-contact-rel">
    <div>Friendship: <strong>${relInfo.friendship ?? 0}/${relMax}</strong></div>
    <div>Affection: <strong>${relInfo.affection ?? 0}/${relMax}</strong></div>
  </div>` : ''}
  <div class="rpg-phone-contact-actions">
    <button class="rpg-phone-btn rpg-phone-btn-primary" data-action="call">📞 Call</button>
    <button class="rpg-phone-btn rpg-phone-btn-secondary" data-action="text">💬 Text</button>
  </div>
  <div style="margin-top:16px;width:100%;">
    <button class="rpg-phone-btn rpg-phone-btn-danger" id="rpg_phone_delete_contact_btn">🗑️ Delete Contact</button>
  </div>
</div>`;

        _logPhoneActivity('contact', contact, 'in', `Viewed contact info for ${contact}${c.relation ? ` (${c.relation})` : ''}`);

        screen.querySelector('[data-action="call"]')?.addEventListener('click', () => {
            _navigateTo('dialer', 'call', { contact });
        });
        screen.querySelector('[data-action="text"]')?.addEventListener('click', () => {
            _navigateTo('messages', 'thread', { contact });
        });
        screen.querySelector('#rpg_phone_delete_contact_btn')?.addEventListener('click', () => {
            const ps2 = getPhoneState();
            if (ps2 && Array.isArray(ps2.phoneContacts)) {
                ps2.phoneContacts = ps2.phoneContacts.filter(x => x.name !== contact);
                savePhoneState();
            }
            _navigateBack();
        });
        return;
    }

    if (pageId === 'add') {
        _setNavTitle('New Contact');
        const knownStoryNpcs = await _getChatLorebookNpcs();
        const existingNames = new Set((ps?.phoneContacts || []).map(c => c.name.toLowerCase()));
        const suggestedNpcs = knownStoryNpcs.filter(k => !existingNames.has(k.name.toLowerCase()));

        const suggestedChipsHTML = suggestedNpcs.length ? `
<div style="margin-bottom:14px;">
  <div class="rpg-phone-muted" style="margin-bottom:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Quick Add from Story NPCs</div>
  <div style="display:flex;flex-wrap:wrap;gap:6px;">
    ${suggestedNpcs.slice(0, 10).map(npc => `
      <button class="rpg-phone-btn-small rpg-phone-npc-chip" data-name="${_escHtml(npc.name)}" data-rel="${_escHtml(npc.relation || '')}" style="border-radius:12px;padding:4px 10px;font-size:12px;">
        👤 ${_escHtml(npc.name)}
      </button>
    `).join('')}
  </div>
</div>` : '';

        screen.innerHTML = `
<div class="rpg-phone-contact-add">
  <h3 style="margin:0 0 12px;font-size:18px;">Add Contact</h3>
  ${suggestedChipsHTML}
  <div style="display:flex;flex-direction:column;gap:12px;">
    <div>
      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:rgba(255,255,255,0.7);">Name</label>
      <input type="text" class="rpg-phone-input-small" id="rpg_phone_new_contact_name" placeholder="e.g. Marcus, Dr. Evans" autofocus/>
    </div>
    <div>
      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:rgba(255,255,255,0.7);">Relationship / Tag</label>
      <input type="text" class="rpg-phone-input-small" id="rpg_phone_new_contact_rel" placeholder="e.g. Fixer, Friend, Boss"/>
    </div>
    <div id="rpg_phone_add_contact_err" style="display:none;color:#e74c3c;font-size:12px;font-weight:500;"></div>
    <button class="rpg-phone-btn rpg-phone-btn-primary" id="rpg_phone_save_contact_btn" style="margin-top:8px;">💾 Save Contact</button>
    <button class="rpg-phone-btn rpg-phone-btn-secondary" id="rpg_phone_cancel_contact_btn">Cancel</button>
  </div>
</div>`;

        // Wire chips
        screen.querySelectorAll('.rpg-phone-npc-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const nameInput = screen.querySelector('#rpg_phone_new_contact_name');
                const relInput  = screen.querySelector('#rpg_phone_new_contact_rel');
                if (nameInput) {
                    nameInput.value = chip.dataset.name || '';
                    if (relInput && chip.dataset.rel) {
                        relInput.value = chip.dataset.rel;
                    }
                    nameInput.focus();
                }
            });
        });

        const doSave = () => {
            const nameInput = screen.querySelector('#rpg_phone_new_contact_name');
            const relInput  = screen.querySelector('#rpg_phone_new_contact_rel');
            const errEl     = screen.querySelector('#rpg_phone_add_contact_err');
            const name = nameInput?.value?.trim();
            const rel  = relInput?.value?.trim() || '';

            if (!name) {
                if (errEl) {
                    errEl.textContent = 'Please enter a contact name.';
                    errEl.style.display = 'block';
                }
                if (nameInput) {
                    nameInput.style.borderColor = '#e74c3c';
                    nameInput.focus();
                }
                return;
            }

            const ps2 = getPhoneState();
            if (ps2) {
                if (!Array.isArray(ps2.phoneContacts)) ps2.phoneContacts = [];
                const existingIdx = ps2.phoneContacts.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
                if (existingIdx >= 0) {
                    // Update existing contact
                    ps2.phoneContacts[existingIdx].name = name;
                    ps2.phoneContacts[existingIdx].relation = rel;
                } else {
                    // Add new contact
                    ps2.phoneContacts.push({ name, relation: rel });
                }
                _logPhoneActivity('contact', name, 'out', `Saved contact: ${name}${rel ? ` (${rel})` : ''}`);
                savePhoneState();
            }
            _navigateBack();
        };

        screen.querySelector('#rpg_phone_save_contact_btn')?.addEventListener('click', doSave);
        screen.querySelector('#rpg_phone_cancel_contact_btn')?.addEventListener('click', () => _navigateBack());

        screen.querySelector('#rpg_phone_new_contact_name')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') doSave();
        });
        screen.querySelector('#rpg_phone_new_contact_rel')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') doSave();
        });
        return;
    }
}



// ─────────────────────────────────────────────────────────────────────────────
// CAMERA APP
// ─────────────────────────────────────────────────────────────────────────────

async function _renderCameraApp(pageId, params, screen) {
    _setNavTitle('Camera');

    if (pageId === 'home') {
        screen.innerHTML = `
<div class="rpg-phone-camera">
  <div class="rpg-phone-camera-viewfinder">
    <div class="rpg-phone-camera-crosshair"></div>
    <p class="rpg-phone-camera-hint">Choose a capture mode below</p>
  </div>
  <div class="rpg-phone-camera-modes">
    <button class="rpg-phone-camera-mode-btn" data-mode="selfie">🤳 Selfie</button>
    <button class="rpg-phone-camera-mode-btn" data-mode="scene">📸 Scene</button>
    <button class="rpg-phone-camera-mode-btn" data-mode="custom">✏️ Custom</button>
  </div>
  <div id="rpg_phone_camera_custom_area" style="display:none;padding:8px;">
    <textarea class="rpg-phone-textarea" id="rpg_phone_camera_desc" rows="3" placeholder="Describe the photo you want to take…"></textarea>
    <button class="rpg-phone-btn rpg-phone-btn-primary" id="rpg_phone_camera_capture_custom">📷 Capture</button>
  </div>
  <div id="rpg_phone_camera_status" class="rpg-phone-muted" style="padding:8px;text-align:center;"></div>
</div>`;

        const statusEl = document.getElementById('rpg_phone_camera_status');

        screen.querySelectorAll('.rpg-phone-camera-mode-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const mode = btn.dataset.mode;
                if (mode === 'custom') {
                    const ca = document.getElementById('rpg_phone_camera_custom_area');
                    if (ca) ca.style.display = ca.style.display === 'none' ? 'block' : 'none';
                    return;
                }
                await _capturePhoto(mode, null, statusEl);
            });
        });

        document.getElementById('rpg_phone_camera_capture_custom')?.addEventListener('click', async () => {
            const desc = document.getElementById('rpg_phone_camera_desc')?.value?.trim();
            if (!desc) return;
            await _capturePhoto('custom', desc, statusEl);
        });
    }
}

async function _capturePhoto(mode, customDesc, statusEl) {
    _markPhoneUsed();
    if (statusEl) statusEl.textContent = '📷 Framing photo…';

    try {
        const s    = getSettings();
        const memo = s.currentMemo || '';
        const { pcName } = _getPlayerCharacterInfo();

        let cardWorldInfo = '';
        if (s.phoneIncludeCardContext !== false) {
            const cardInfo = _getActiveCardInfo();
            if (cardInfo?.cardData?.description || cardInfo?.cardData?.data?.description) {
                cardWorldInfo = (cardInfo.cardData.description || cardInfo.cardData.data.description).slice(0, 300).replace(/[\r\n]+/g, ' ').trim();
            }
        }

        let prompt = '';
        let photoLabel = '';

        if (mode === 'selfie') {
            photoLabel = `Selfie (${pcName || 'Me'})`;
            const charMatch = memo.match(/\[CHARACTER\]([\s\S]*?)\[\/CHARACTER\]/i);
            const charInfo  = charMatch ? charMatch[1].slice(0, 300) : '';
            prompt = `Smartphone front-facing selfie portrait photo of ${pcName || 'character'}. Appearance details: ${charInfo || 'young adult'}. Realistic candid selfie style, natural room lighting, modern smartphone camera aesthetic, high detail.`;
        } else if (mode === 'scene') {
            photoLabel = 'Scene Photo';
            const locMatch = memo.match(/\[LOCATION\]([\s\S]*?)\[\/LOCATION\]/i);
            const timeInfo = getInWorldTimeInfo().rawTime;
            const locInfo = locMatch ? locMatch[1].slice(0, 200) : '';
            const settingContext = locInfo || cardWorldInfo || 'modern environment';
            prompt = `Realistic smartphone photo of current scene. Environment/Setting: ${settingContext}. Time of day: ${timeInfo || 'daytime'}. Candid photography, natural lighting, sharp focus.`;
        } else {
            photoLabel = customDesc ? `Photo: ${customDesc.slice(0, 30)}` : 'Custom Photo';
            prompt = `Realistic smartphone photo: ${customDesc}. Candid photography, sharp detail, natural lighting.`;
        }

        if (statusEl) statusEl.textContent = '🎨 Generating photo…';

        let imageUrl = null;
        try {
            imageUrl = await generatePortraitDirect(prompt, photoLabel);
        } catch (genErr) {
            console.warn('[Phone] generatePortraitDirect error:', genErr);
            // ST slash command fallback
            const { SlashCommandParser } = SillyTavern.getContext?.() || {};
            if (SlashCommandParser?.commands?.['imagine']) {
                const parser = new SlashCommandParser();
                const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const result = await parser.parse(`/imagine quiet=true gallery=false extend=false "${escapedPrompt}"`, true).execute();
                if (result && result.pipe) imageUrl = result.pipe;
            }
            if (!imageUrl) throw genErr;
        }

        const timeInfo = getInWorldTimeInfo();
        const turns = SillyTavern.getContext?.()?.chat?.length || 0;
        const ps = getPhoneState();
        if (ps) {
            if (!Array.isArray(ps.phoneGallery)) ps.phoneGallery = [];
            ps.phoneGallery.push({
                id            : `photo_${Date.now()}`,
                prompt,
                label         : photoLabel,
                imageUrl      : imageUrl || null,
                mode,
                inWorldMinutes: timeInfo.totalMinutes,
                inWorldTimeStr: timeInfo.clockOnly || timeInfo.rawTime,
                turnNumber    : turns,
                timestamp     : Date.now(),
            });

            // Record to phone activity history via universal logger
            const photoDesc = mode === 'selfie' ? 'selfie' : (mode === 'scene' ? 'scene photo' : (customDesc ? `photo: "${customDesc}"` : 'photo'));
            _logPhoneActivity('camera', 'Camera', 'out', `Took a ${photoDesc}`);

            savePhoneState();
        }

        if (statusEl) statusEl.textContent = '✅ Photo saved to Gallery!';
        setTimeout(() => {
            if (statusEl) statusEl.textContent = '';
        }, 3000);

    } catch (e) {
        if (statusEl) statusEl.textContent = `❌ Capture failed: ${e.message || e}`;
        console.error('[Phone] Camera capture error:', e);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// GALLERY APP
// ─────────────────────────────────────────────────────────────────────────────

function _renderGalleryApp(pageId, params, screen) {
    _setNavTitle('Gallery');
    const ps = getPhoneState();
    const gallery = (ps?.phoneGallery || []).slice().reverse();

    if (pageId === 'photo' && params.photo) {
        const photo = params.photo;
        _setNavTitle('Photo');
        _logPhoneActivity('gallery', 'Gallery', 'in', `Viewed photo: "${_summarizeText(photo.label || photo.prompt, 80)}"`);

        screen.innerHTML = `
<div class="rpg-phone-photo-detail">
  ${photo.imageUrl
    ? `<img src="${_escHtml(photo.imageUrl)}" class="rpg-phone-photo-full" alt="Photo"/>`
    : `<div class="rpg-phone-gallery-placeholder-lg">📷</div>`}
  <div class="rpg-phone-photo-caption">${_escHtml(photo.label || photo.prompt || '')}</div>
  ${photo.inWorldTimeStr ? `<div class="rpg-phone-muted" style="margin-top:6px;font-size:11px;text-align:center;">Taken at: ${_escHtml(photo.inWorldTimeStr)}</div>` : ''}
</div>`;
        return;
    }

    if (!gallery.length) {
        screen.innerHTML = `<div class="rpg-phone-gallery-empty"><span>📷</span><p>No photos yet.<br>Use the Camera app to take photos.</p></div>`;
        return;
    }

    _logPhoneActivity('gallery', 'Gallery', 'in', `Viewed photo gallery (${gallery.length} photos)`);

    const items = gallery.map((photo, i) => {
        const thumb = photo.imageUrl
            ? `<img src="${_escHtml(photo.imageUrl)}" class="rpg-phone-gallery-thumb" alt="Photo"/>`
            : `<div class="rpg-phone-gallery-thumb rpg-phone-gallery-placeholder">📷</div>`;
        return `
<div class="rpg-phone-gallery-item" data-idx="${i}" role="button" tabindex="0">
  ${thumb}
  <div class="rpg-phone-gallery-label">${_escHtml(photo.label || photo.mode || 'photo')}</div>
</div>`;
    }).join('');

    screen.innerHTML = `<div class="rpg-phone-gallery-grid">${items}</div>`;

    screen.querySelectorAll('.rpg-phone-gallery-item').forEach((el) => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            if (gallery[idx]) {
                _navigateTo('gallery', 'photo', { photo: gallery[idx] });
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHONE SETTINGS PAGE (in-phone)
// ─────────────────────────────────────────────────────────────────────────────

function _renderPhoneSettingsApp(pageId, params, screen) {
    _setNavTitle('Settings');
    const s = getSettings();

    screen.innerHTML = `
<div class="rpg-phone-settings-app">
  <h3>Phone Settings</h3>
  <label class="rpg-phone-settings-row">
    <span>Include active card & world context in AI prompts</span>
    <input type="checkbox" id="rpg_phone_card_ctx_toggle" ${s.phoneIncludeCardContext !== false ? 'checked' : ''}/>
  </label>
  <label class="rpg-phone-settings-row">
    <span>Context depth (interactions in AI context)</span>
    <input type="range" min="1" max="100" value="${s.phoneContextDepth || 20}" id="rpg_phone_ctx_depth_slider"/>
    <span id="rpg_phone_ctx_depth_val">${s.phoneContextDepth || 20}</span>
  </label>
  <label class="rpg-phone-settings-row">
    <span>NPC contact chance per turn (%)</span>
    <input type="range" min="0" max="40" value="${s.phoneNpcContactChance ?? 8}" id="rpg_phone_npc_chance_slider"/>
    <span id="rpg_phone_npc_chance_val">${s.phoneNpcContactChance ?? 8}%</span>
  </label>
  <button class="rpg-phone-btn rpg-phone-btn-danger" id="rpg_phone_clear_history_btn">🗑️ Clear Phone History</button>
</div>`;

    const cardToggle = document.getElementById('rpg_phone_card_ctx_toggle');
    cardToggle?.addEventListener('change', () => {
        const s2 = getSettings();
        s2.phoneIncludeCardContext = cardToggle.checked;
        saveSettings();
        savePhoneState();
    });

    const depthSlider = document.getElementById('rpg_phone_ctx_depth_slider');
    const depthVal    = document.getElementById('rpg_phone_ctx_depth_val');
    depthSlider?.addEventListener('input', () => {
        const v = parseInt(depthSlider.value, 10);
        if (depthVal) depthVal.textContent = v;
        s.phoneContextDepth = v;
        savePhoneState();
    });

    const chanceSlider = document.getElementById('rpg_phone_npc_chance_slider');
    const chanceVal    = document.getElementById('rpg_phone_npc_chance_val');
    chanceSlider?.addEventListener('input', () => {
        const v = parseInt(chanceSlider.value, 10);
        if (chanceVal) chanceVal.textContent = `${v}%`;
        s.phoneNpcContactChance = v;
        savePhoneState();
    });

    document.getElementById('rpg_phone_clear_history_btn')?.addEventListener('click', () => {
        const ps = getPhoneState();
        if (ps) {
            ps.phoneHistory  = [];
            ps.phoneUnread   = { messages: 0, calls: 0 };
            savePhoneState();
            _updateNotificationBadge();
            alert('Phone history cleared.');
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings panel binding (called from index.js)
// ─────────────────────────────────────────────────────────────────────────────

export function bindPhone(settingsContainer) {
    // Register global bridges immediately
    globalThis._rpgBuildPhoneContextBlock  = buildPhoneContextBlock;
    globalThis._rpgMaybeFireNpcContact     = maybeFireNpcContact;
    globalThis._rpgOpenPhone               = openPhone;
    globalThis._rpgClosePhone              = closePhone;
    globalThis._rpgTogglePhone             = togglePhone;
    globalThis._rpgOnPhoneGenerationStarted = onPhoneGenerationStarted;

    // Wire phone icon toggle button (in State Tracker header)
    const iconBtn = document.getElementById('rpg_phone_icon_btn');
    if (iconBtn) {
        iconBtn.addEventListener('click', togglePhone);
    }

    // Wire dock buttons once the phone is open
    document.addEventListener('click', e => {
        const btn = e.target.closest('.rpg-phone-dock-btn');
        if (btn && _isOpen) {
            _navigateTo(btn.dataset.app);
        }
    });

    // Settings panel UI bindings
    if (!settingsContainer) return;

    // Enable/disable checkbox
    const enabledCb = settingsContainer.querySelector('#rpg_phone_enabled_cb');
    if (enabledCb) {
        const s = getSettings();
        enabledCb.checked = !!s.phoneEnabled;
        enabledCb.addEventListener('change', () => {
            const s2 = getSettings();
            s2.phoneEnabled = enabledCb.checked;
            if (s2.modules) s2.modules.phone = enabledCb.checked;
            if (!enabledCb.checked) closePhone();
            // Show/hide phone icon in panel header
            const icon = document.getElementById('rpg_phone_icon_btn');
            if (icon) icon.style.display = enabledCb.checked ? '' : 'none';
            saveSettings();
        });
    }

    // Include Card Context checkbox
    const cardCtxCb = settingsContainer.querySelector('#rpg_phone_include_card_context_cb');
    if (cardCtxCb) {
        const s = getSettings();
        cardCtxCb.checked = s.phoneIncludeCardContext !== false;
        cardCtxCb.addEventListener('change', () => {
            const s2 = getSettings();
            s2.phoneIncludeCardContext = cardCtxCb.checked;
            saveSettings();
        });
    }

    // Context depth slider
    const depthSlider = settingsContainer.querySelector('#rpg_phone_ctx_depth');
    const depthLabel  = settingsContainer.querySelector('#rpg_phone_ctx_depth_label');
    if (depthSlider) {
        const s = getSettings();
        depthSlider.value = s.phoneContextDepth || 20;
        if (depthLabel) depthLabel.textContent = depthSlider.value;
        depthSlider.addEventListener('input', () => {
            if (depthLabel) depthLabel.textContent = depthSlider.value;
            const s2 = getSettings();
            s2.phoneContextDepth = parseInt(depthSlider.value, 10);
            saveSettings();
        });
    }

    // NPC contact chance slider
    const chanceSlider = settingsContainer.querySelector('#rpg_phone_npc_chance');
    const chanceLabel  = settingsContainer.querySelector('#rpg_phone_npc_chance_label');
    if (chanceSlider) {
        const s = getSettings();
        chanceSlider.value = s.phoneNpcContactChance ?? 8;
        if (chanceLabel) chanceLabel.textContent = `${chanceSlider.value}%`;
        chanceSlider.addEventListener('input', () => {
            if (chanceLabel) chanceLabel.textContent = `${chanceSlider.value}%`;
            const s2 = getSettings();
            s2.phoneNpcContactChance = parseInt(chanceSlider.value, 10);
            saveSettings();
        });
    }

    // Reset phone data button
    const resetBtn = settingsContainer.querySelector('#rpg_phone_reset_data_btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (!confirm('Clear all phone data for this chat? (contacts, messages, history, apps, gallery)')) return;
            const ps = getPhoneState();
            if (ps) {
                ps.phoneHistory  = [];
                ps.phoneContacts = [];
                ps.phoneApps     = [];
                ps.phoneCallLog  = [];
                ps.phoneMessages = {};
                ps.phoneUnread   = { messages: 0, calls: 0 };
                ps.phoneGallery  = [];
                savePhoneState();
                _updateNotificationBadge();
            }
        });
    }

    // ── Phone AI Connection settings ─────────────────────────────────────────
    const connSrc = settingsContainer.querySelector('#rpg_phone_connection_source');
    if (connSrc) {
        const s = getSettings();
        connSrc.value = s.phoneConnectionSource || 'default';
        _syncPhoneConnGroups(settingsContainer, connSrc.value);
        connSrc.addEventListener('change', () => {
            const s2 = getSettings();
            s2.phoneConnectionSource = connSrc.value;
            saveSettings();
            _syncPhoneConnGroups(settingsContainer, connSrc.value);
        });
    }

    // Profile ID
    const profileId = settingsContainer.querySelector('#rpg_phone_connection_profile_id');
    if (profileId) {
        const s = getSettings();
        profileId.value = s.phoneConnectionProfileId || '';
        profileId.addEventListener('input', () => {
            getSettings().phoneConnectionProfileId = profileId.value.trim();
            saveSettings();
        });
    }

    // Ollama URL
    const ollamaUrl = settingsContainer.querySelector('#rpg_phone_ollama_url');
    if (ollamaUrl) {
        const s = getSettings();
        ollamaUrl.value = s.phoneOllamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            getSettings().phoneOllamaUrl = ollamaUrl.value.trim();
            saveSettings();
        });
    }

    // OpenAI URL / Key / Model
    const openaiUrl = settingsContainer.querySelector('#rpg_phone_openai_url');
    if (openaiUrl) {
        const s = getSettings();
        openaiUrl.value = s.phoneOpenaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            getSettings().phoneOpenaiUrl = openaiUrl.value.trim();
            saveSettings();
        });
    }
    const openaiKey = settingsContainer.querySelector('#rpg_phone_openai_key');
    if (openaiKey) {
        const s = getSettings();
        openaiKey.value = s.phoneOpenaiKey || '';
        openaiKey.addEventListener('input', () => {
            getSettings().phoneOpenaiKey = openaiKey.value.trim();
            saveSettings();
        });
    }
    const openaiModel = settingsContainer.querySelector('#rpg_phone_openai_model');
    if (openaiModel) {
        const s = getSettings();
        openaiModel.value = s.phoneOpenaiModel || '';
        openaiModel.addEventListener('input', () => {
            getSettings().phoneOpenaiModel = openaiModel.value.trim();
            saveSettings();
        });
    }

    // Max tokens
    const maxTok = settingsContainer.querySelector('#rpg_phone_max_tokens');
    if (maxTok) {
        const s = getSettings();
        maxTok.value = s.phoneMaxTokens ?? 0;
        maxTok.addEventListener('input', () => {
            const v = parseInt(maxTok.value, 10);
            getSettings().phoneMaxTokens = isNaN(v) ? 0 : v;
            saveSettings();
        });
    }

    // Initial badge state
    _updateNotificationBadge();
}

/** Show/hide connection-specific field groups based on selected source. */
function _syncPhoneConnGroups(container, source) {
    const groups = { profile: 'rpg_phone_profile_group', ollama: 'rpg_phone_ollama_group', openai: 'rpg_phone_openai_group' };
    for (const [src, id] of Object.entries(groups)) {
        const el = container.querySelector(`#${id}`);
        if (el) el.style.display = source === src ? '' : 'none';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Genre skin helper (exported for character creator to call after genre change)
// ─────────────────────────────────────────────────────────────────────────────

export function refreshPhoneSkin() {
    if (_isOpen) _applyGenreSkin();
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function _escHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level global bridge registration
// ─────────────────────────────────────────────────────────────────────────────
globalThis._rpgBuildPhoneContextBlock   = buildPhoneContextBlock;
globalThis._rpgMaybeFireNpcContact      = maybeFireNpcContact;
globalThis._rpgOpenPhone                = openPhone;
globalThis._rpgClosePhone               = closePhone;
globalThis._rpgTogglePhone              = togglePhone;
globalThis._rpgOnPhoneGenerationStarted = onPhoneGenerationStarted;

