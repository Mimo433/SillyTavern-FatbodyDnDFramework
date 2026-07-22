/**
 * state-manager.js — Multihog D&D Framework
 * Game state schema, defaults, persistence, migration, and profile I/O.
 * Owns the single source of truth for all runtime state (currentMemo, quests,
 * modules, chat-linked snapshots, connection settings, etc.).
 * Public barrel: leaf modules live under src/state/; consumers keep importing here.
 *
 * Imports: constants.js, src/state/*
 * Imported by: virtually everything — the root dependency.
 */

import { DEFAULT_STOCK_PROMPTS, BLOCK_ORDER } from './constants.js';
import { MODULE_NAME } from './src/state/schema-sections.js';
import { getNpcRelationshipMax } from './src/state/relationship-math.js';
import { DEFAULT_MODULES } from './src/state/default-modules.js';
import { getSettings, stripChatStateGlobalUiPrefs } from './src/state/settings.js';

export * from './src/state/schema-sections.js';
export * from './src/state/versions.js';
export * from './src/state/relationship-math.js';
export * from './src/state/relationship-dom.js';
export * from './src/state/relationship-prompts.js';
export * from './src/state/portrait-prompts.js';
export * from './src/state/module-instructions.js';
export * from './src/state/default-modules.js';
export * from './src/state/defaults.js';
export * from './src/state/factory-and-diff.js';
export * from './src/state/settings.js';

// settings.js self-binds getSettings into settings-ref on import.

// ── Core settings accessor ─────────────────────────────────────────────────────

export function saveChatState(chatId, opts = {}) {
    if (!chatId) return;
    if (typeof globalThis._rpgPortraitMigrationLocked === 'function' && globalThis._rpgPortraitMigrationLocked()) {
        return;
    }
    // Flush pending raw-textarea edits into settings.currentMemo before snapshotting.
    // The flush must NOT call saveChatState/saveSettings (re-entrancy).
    if (typeof globalThis._rpgFlushRawMemoChanges === 'function') {
        globalThis._rpgFlushRawMemoChanges();
    }
    const s = getSettings();
    if (!s.chatStates) s.chatStates = {};
    // This stamp belongs to the specific chat snapshot. The top-level timestamp is
    // shared by every chat, so it cannot safely decide whether this chat's disk memo
    // is newer than a browser-local recovery snapshot.
    const memoPersistedAt = Date.now();
    s.memoPersistedAt = memoPersistedAt;
    // Preserve fields that are written outside the normal save cycle (e.g. campaignBooks)
    const existing = s.chatStates[chatId] || {};
    s.chatStates[chatId] = {
        currentMemo:  s.currentMemo,
        memoPersistedAt,
        memoHistory:  JSON.parse(JSON.stringify(s.memoHistory)),
        lastDelta:    s.lastDelta || '',
        customPortraits: JSON.parse(JSON.stringify(s.customPortraits || {})),
        customLocationImages: JSON.parse(JSON.stringify(s.customLocationImages || {})),
        modules:      JSON.parse(JSON.stringify(s.modules)),
        blockOrder:   JSON.parse(JSON.stringify(s.blockOrder  || BLOCK_ORDER)),
        stockPrompts: snapshotStockPromptsForProfile(s.stockPrompts),
        customFields: JSON.parse(JSON.stringify(s.customFields || [])),
        quests:       JSON.parse(JSON.stringify(s.quests || [])), // persist full array (incl. completed) for cross-session UI display
        historyIndex: s.historyIndex ?? -1,
        activeRouterKeys: JSON.parse(JSON.stringify(s.activeRouterKeys || [])),
        activeWorldKeys:  JSON.parse(JSON.stringify(s.activeWorldKeys || [])),
        keywordActivatedKeys: JSON.parse(JSON.stringify(s.keywordActivatedKeys || [])),
        routerLog:    JSON.parse(JSON.stringify(s.routerLog || [])),
        routerCampaignPrefix: s.routerCampaignPrefix || '',
        routerLookback: s.routerLookback || 4,
        routerLastRunChatLength: s.routerLastRunChatLength ?? 0,
        routerLastRunAt: s.routerLastRunAt ?? 0,
        routerDirectPrompt: s.routerDirectPrompt || '',
        routerDirectLookback: s.routerDirectLookback || 10,
        routerDefaultPosition: s.routerDefaultPosition ?? 4,
        routerDefaultDepth: s.routerDefaultDepth ?? 4,
        routerDefaultOrder: s.routerDefaultOrder ?? 100,
        routerDefaultRole: s.routerDefaultRole ?? 0,
        loreInjectionPosition: s.loreInjectionPosition ?? 4,
        loreInjectionDepth: s.loreInjectionDepth ?? 4,
        loreInjectionRole: s.loreInjectionRole ?? 0,
        worldProgressionLookback: s.worldProgressionLookback ?? 20,
        worldProgressionHistoryLookback: s.worldProgressionHistoryLookback ?? 0,
        worldProgressionInjectionPosition: s.worldProgressionInjectionPosition ?? 4,
        worldProgressionInjectionDepth: s.worldProgressionInjectionDepth ?? 3,
        worldProgressionInjectionRole: s.worldProgressionInjectionRole ?? 0,
        worldProgressionRandomizeNPCs: s.worldProgressionRandomizeNPCs ?? false,
        worldProgressionRandomSkeletonNPCCount: s.worldProgressionRandomSkeletonNPCCount ?? 2,
        worldProgressionRandomNarrativeNPCCount: s.worldProgressionRandomNarrativeNPCCount ?? 3,
        worldProgressionRandomizeLocations: s.worldProgressionRandomizeLocations ?? false,
        worldProgressionRandomSkeletonLocationCount: s.worldProgressionRandomSkeletonLocationCount ?? 2,
        worldProgressionRandomNarrativeLocationCount: s.worldProgressionRandomNarrativeLocationCount ?? 2,
        worldProgressionRandomizeFactions: s.worldProgressionRandomizeFactions ?? false,
        worldProgressionRandomSkeletonFactionCount: s.worldProgressionRandomSkeletonFactionCount ?? 2,
        worldProgressionRandomNarrativeFactionCount: s.worldProgressionRandomNarrativeFactionCount ?? 2,
        worldProgressionRandomizeConflicts: s.worldProgressionRandomizeConflicts ?? false,
        worldProgressionRandomConflictCount: s.worldProgressionRandomConflictCount ?? 3,
        worldProgressionSkeletonFactions: s.worldProgressionSkeletonFactions ?? 4,
        worldProgressionSkeletonLocations: s.worldProgressionSkeletonLocations ?? 4,
        worldProgressionSkeletonNPCs: s.worldProgressionSkeletonNPCs ?? 0,
        worldProgressionSkeletonConflicts: s.worldProgressionSkeletonConflicts ?? 3,
        // World Progression per-chat time tracking
        worldProgressionLastFiredAtMinutes: s.worldProgressionLastFiredAtMinutes ?? -1,
        worldProgressionLastFiredPeriodLabel: s.worldProgressionLastFiredPeriodLabel || '',
        worldProgressionSkeletonAtmosphereSummary: s.worldProgressionSkeletonAtmosphereSummary || '',
        worldProgressionSkeletonAtmosphereLookback: s.worldProgressionSkeletonAtmosphereLookback ?? 30,
        worldProgressionSkeletonUseExisting: s.worldProgressionSkeletonUseExisting ?? true,
        worldProgressionConsolidateEnabled: s.worldProgressionConsolidateEnabled ?? false,
        worldProgressionConsolidateInterval: s.worldProgressionConsolidateInterval ?? 7,
        worldProgressionExclusionList: s.worldProgressionExclusionList || '',

        // Per-chat time/date formatting (24h clock, DD/MM/YYYY vs Day N, initial anchor)
        use24hTime: !!s.use24hTime,
        useDdMmYyFormat: !!s.useDdMmYyFormat,
        initialDate: s.initialDate || 'Day 1',
        npcRelationshipMax: getNpcRelationshipMax(s),

        // Preserve lorebook stack link — written by Link button and router, not by normal state saves
        campaignBooks: existing.campaignBooks || [],

        // Real-Time Mode: last scene location we generated art for (survives F5)
        lastImmersionSceneArtPath: existing.lastImmersionSceneArtPath || null,
        // Chat length at last Real-Time scene-art generation (for every-N-outputs mode)
        lastImmersionSceneArtChatLen: existing.lastImmersionSceneArtChatLen ?? null,

        // Preserve Player Character pseudo-persona which is injected into the chat state
        playerCharacter: existing.playerCharacter,
    };

    // Sync WAL before the async disk write — survives F5 if /api/settings/save is cancelled.
    writeModuleSchemaBackup(chatId);
    // Drop any legacy global-UI keys copied into older partitions.
    stripChatStateGlobalUiPrefs(s);
    
    // Use a synchronous save so data is not lost if the page is closed before
    // a debounced timer fires (the root cause of the PC/state/relationship loss bug).
    // saveChatState is always called with an explicit chatId so there is no
    // cross-chat leakage risk from this call itself.
    // When called from our saveSettings(), skipDiskWrite avoids a duplicate in-flight save.
    if (opts.skipDiskWrite) return;
    const ctx = SillyTavern.getContext();
    if (typeof ctx.saveSettings === 'function') {
        ctx.saveSettings();
    } else if (typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    }
}

// ── Profile I/O ───────────────────────────────────────────────────────────────

/**
 * Deep-clones stock module prompts for profile/chat persistence, merging the
 * live overrides on top of DEFAULT_STOCK_PROMPTS so every variant key
 * (time_24h, time_ddmmyy, etc.) is captured even if only a subset was edited.
 * @param {Record<string, string>|null|undefined} stockPrompts
 * @returns {Record<string, string>}
 */
export function snapshotStockPromptsForProfile(stockPrompts) {
    return {
        ...JSON.parse(JSON.stringify(DEFAULT_STOCK_PROMPTS)),
        ...JSON.parse(JSON.stringify(stockPrompts || {})),
    };
}

/**
 * Restores stock module prompts from a profile snapshot, filling any keys
 * missing in older profiles from current defaults.
 * @param {Record<string, string>|null|undefined} profileStockPrompts
 * @returns {Record<string, string>}
 */
export function loadStockPromptsFromProfile(profileStockPrompts) {
    if (!profileStockPrompts) {
        return JSON.parse(JSON.stringify(DEFAULT_STOCK_PROMPTS));
    }
    return {
        ...JSON.parse(JSON.stringify(DEFAULT_STOCK_PROMPTS)),
        ...JSON.parse(JSON.stringify(profileStockPrompts)),
    };
}

/**
 * Saves the current tracker state into a named profile slot.
 * @param {string} name
 */
export function saveProfile(name) {
    const s = getSettings();
    if (!name) return;
    if (!s.profiles) s.profiles = {};
    s.profiles[name] = {
        currentMemo: s.currentMemo,
        memoHistory: JSON.parse(JSON.stringify(s.memoHistory)),
        modules: JSON.parse(JSON.stringify(s.modules)),
        blockOrder: JSON.parse(JSON.stringify(s.blockOrder || BLOCK_ORDER)),
        stockPrompts: snapshotStockPromptsForProfile(s.stockPrompts),
        modulePageSizes: JSON.parse(JSON.stringify(s.modulePageSizes || {})),
        customFields: JSON.parse(JSON.stringify(s.customFields || [])),
        // quests are derived from currentMemo on load — not persisted separately
        lastDelta: s.lastDelta || '',
        historyIndex: s.historyIndex ?? -1,
        activeRouterKeys: JSON.parse(JSON.stringify(s.activeRouterKeys || [])),
        activeWorldKeys:  JSON.parse(JSON.stringify(s.activeWorldKeys || [])),
        routerLog:    JSON.parse(JSON.stringify(s.routerLog || [])),
        routerCampaignPrefix: s.routerCampaignPrefix || '',
        routerLookback: s.routerLookback || 4,
        routerLastRunChatLength: s.routerLastRunChatLength ?? 0,
        routerLastRunAt: s.routerLastRunAt ?? 0,
        routerDirectPrompt: s.routerDirectPrompt || '',
        routerDefaultPosition: s.routerDefaultPosition ?? 4,
        routerDefaultDepth: s.routerDefaultDepth ?? 4,
        routerDefaultOrder: s.routerDefaultOrder ?? 100,
        routerDefaultRole: s.routerDefaultRole ?? 0,
        loreInjectionPosition: s.loreInjectionPosition ?? 4,
        loreInjectionDepth: s.loreInjectionDepth ?? 4,
        loreInjectionRole: s.loreInjectionRole ?? 0,
        worldProgressionLookback: s.worldProgressionLookback ?? 20,
        worldProgressionHistoryLookback: s.worldProgressionHistoryLookback ?? 0,
        worldProgressionInjectionPosition: s.worldProgressionInjectionPosition ?? 4,
        worldProgressionInjectionDepth: s.worldProgressionInjectionDepth ?? 3,
        worldProgressionInjectionRole: s.worldProgressionInjectionRole ?? 0,
        worldProgressionRandomizeNPCs: s.worldProgressionRandomizeNPCs ?? false,
        worldProgressionRandomSkeletonNPCCount: s.worldProgressionRandomSkeletonNPCCount ?? 2,
        worldProgressionRandomNarrativeNPCCount: s.worldProgressionRandomNarrativeNPCCount ?? 3,
        worldProgressionRandomizeLocations: s.worldProgressionRandomizeLocations ?? false,
        worldProgressionRandomSkeletonLocationCount: s.worldProgressionRandomSkeletonLocationCount ?? 2,
        worldProgressionRandomNarrativeLocationCount: s.worldProgressionRandomNarrativeLocationCount ?? 2,
        worldProgressionRandomizeFactions: s.worldProgressionRandomizeFactions ?? false,
        worldProgressionRandomSkeletonFactionCount: s.worldProgressionRandomSkeletonFactionCount ?? 2,
        worldProgressionRandomNarrativeFactionCount: s.worldProgressionRandomNarrativeFactionCount ?? 2,
        worldProgressionRandomizeConflicts: s.worldProgressionRandomizeConflicts ?? false,
        worldProgressionRandomConflictCount: s.worldProgressionRandomConflictCount ?? 3,
        worldProgressionSkeletonFactions: s.worldProgressionSkeletonFactions ?? 4,
        worldProgressionSkeletonLocations: s.worldProgressionSkeletonLocations ?? 4,
        worldProgressionSkeletonNPCs: s.worldProgressionSkeletonNPCs ?? 0,
        worldProgressionSkeletonConflicts: s.worldProgressionSkeletonConflicts ?? 3,
        worldProgressionLastFiredAtMinutes: s.worldProgressionLastFiredAtMinutes ?? -1,
        worldProgressionLastFiredPeriodLabel: s.worldProgressionLastFiredPeriodLabel || '',
        worldProgressionConsolidateEnabled: s.worldProgressionConsolidateEnabled ?? false,
        worldProgressionConsolidateInterval: s.worldProgressionConsolidateInterval ?? 7,
        worldProgressionSkeletonAtmosphereSummary: s.worldProgressionSkeletonAtmosphereSummary || '',
        worldProgressionSkeletonAtmosphereLookback: s.worldProgressionSkeletonAtmosphereLookback ?? 30,
        worldProgressionSkeletonUseExisting: s.worldProgressionSkeletonUseExisting ?? true,
        worldProgressionExclusionList: s.worldProgressionExclusionList || '',

        portraitGeneratorSource: s.portraitGeneratorSource ?? "native",
        portraitSkipPromptDialog: s.portraitSkipPromptDialog ?? false,
        hideImageGenToasts: s.hideImageGenToasts ?? false,
        portraitAutoGenerateParty: s.portraitAutoGenerateParty ?? false,
        portraitAutoGeneratePlayer: s.portraitAutoGeneratePlayer ?? false,
        portraitAutoGenerateEnemies: s.portraitAutoGenerateEnemies ?? false,
        portraitAutoGenerateNpcs: s.portraitAutoGenerateNpcs ?? false,
        portraitAutoGenerateLocations: s.portraitAutoGenerateLocations ?? false,
        portraitAutoGenerateSceneView: s.portraitAutoGenerateSceneView ?? false,
        portraitRealtimeTriggerMode: s.portraitRealtimeTriggerMode || 'location_change',
        portraitRealtimeEveryNOutputs: Math.max(1, Number(s.portraitRealtimeEveryNOutputs) || 1),
        portraitRegenerateVisitedLocations: s.portraitRegenerateVisitedLocations ?? false,
        locationImages: !!s.locationImages,
        portraitConnectionSource: s.portraitConnectionSource ?? "default",
        portraitConnectionProfileId: s.portraitConnectionProfileId || "",
        portraitCompletionPresetId: s.portraitCompletionPresetId || "",
        portraitOllamaUrl: s.portraitOllamaUrl || "http://localhost:11434",
        portraitOllamaModel: s.portraitOllamaModel || "",
        portraitOpenaiUrl: s.portraitOpenaiUrl || "",
        portraitOpenaiKey: s.portraitOpenaiKey || "",
        portraitOpenaiModel: s.portraitOpenaiModel || "",
        worldConnectionSource: s.worldConnectionSource ?? "default",
        worldConnectionProfileId: s.worldConnectionProfileId || "",
        worldCompletionPresetId: s.worldCompletionPresetId || "",
        worldOllamaUrl: s.worldOllamaUrl || "http://localhost:11434",
        worldOllamaModel: s.worldOllamaModel || "",
        worldOpenaiUrl: s.worldOpenaiUrl || "",
        worldOpenaiKey: s.worldOpenaiKey || "",
        worldOpenaiModel: s.worldOpenaiModel || "",
        gameSystemWizardConnectionSource: s.gameSystemWizardConnectionSource ?? "default",
        gameSystemWizardConnectionProfileId: s.gameSystemWizardConnectionProfileId || "",
        gameSystemWizardCompletionPresetId: s.gameSystemWizardCompletionPresetId || "",
        gameSystemWizardOllamaUrl: s.gameSystemWizardOllamaUrl || "http://localhost:11434",
        gameSystemWizardOllamaModel: s.gameSystemWizardOllamaModel || "",
        gameSystemWizardOpenaiUrl: s.gameSystemWizardOpenaiUrl || "",
        gameSystemWizardOpenaiKey: s.gameSystemWizardOpenaiKey || "",
        gameSystemWizardOpenaiModel: s.gameSystemWizardOpenaiModel || "",
        gameSystemWizardSystemPrompt: s.gameSystemWizardSystemPrompt || "",
    };
    s.activeProfile = name;
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Deletes a named profile slot.
 * @param {string} name
 */
export function deleteProfile(name) {
    const s = getSettings();
    if (!s.profiles?.[name]) return;
    delete s.profiles[name];
    if (s.activeProfile === name) s.activeProfile = '';
    SillyTavern.getContext().saveSettingsDebounced();
}

/**
 * Safely sanitizes router state arrays to prevent crashes from dirty/malformed data.
 * @param {Record<string, any>} s - The settings object to sanitize.
 */
export function sanitizeRouterState(s) {
    if (!s) return;
    const isGoodId = (id) => typeof id === 'string' && id.includes('::');

    if (Array.isArray(s.activeRouterKeys)) {
        s.activeRouterKeys = s.activeRouterKeys.filter(isGoodId);
    } else {
        s.activeRouterKeys = [];
    }

    if (Array.isArray(s.activeWorldKeys)) {
        s.activeWorldKeys = s.activeWorldKeys.filter(isGoodId);
    } else {
        s.activeWorldKeys = [];
    }

    if (Array.isArray(s.keywordActivatedKeys)) {
        s.keywordActivatedKeys = s.keywordActivatedKeys.filter(isGoodId);
    } else {
        s.keywordActivatedKeys = [];
    }

    if (Array.isArray(s.routerLog)) {
        s.routerLog = s.routerLog.filter(log => {
            if (!log || typeof log !== 'object') return false;

            if (Array.isArray(log.record)) {
                log.record = log.record.filter(isGoodId);
            } else {
                log.record = [];
            }

            if (Array.isArray(log.activate)) {
                log.activate = log.activate.filter(isGoodId);
            } else {
                log.activate = [];
            }

            if (Array.isArray(log.deactivate)) {
                log.deactivate = log.deactivate.filter(isGoodId);
            } else {
                log.deactivate = [];
            }

            return true;
        });
    } else {
        s.routerLog = [];
    }
}

/**
 * Dynamically adjusts timestamp formats (Day X/N vs DD/MM/YYYY and 12h vs 24h) inside prompt instructions.
 * @param {string} prompt
 * @param {object} settings
 * @returns {string}
 */
export function adjustPromptTimestamps(prompt, settings) {
    if (!prompt) return prompt;
    const isCalendar = !!settings.useDdMmYyFormat;
    const is24h = !!settings.use24hTime;

    let result = prompt;

    if (isCalendar) {
        if (is24h) {
            // Target: DD/MM/YYYY, HH:MM (24h)
            result = result
                .replace(/Day ([1-9])/g, '0$1/01/2026')
                .replace(/Day N/g, 'DD/MM/YYYY')
                .replace(/Day X/g, 'DD/MM/YYYY')
                .replace(/Day 0/g, '31/12/2025')
                .replace(/12:15 AM/g, '00:15')
                .replace(/11:52 AM/g, '11:52')
                .replace(/10:00 PM/g, '22:00')
                .replace(/08:00 AM/g, '08:00')
                .replace(/06:00 PM/g, '18:00')
                .replace(/14:00/g, '14:00')
                .replace(/10:42/g, '10:42')
                .replace(/10:44/g, '10:44')
                .replace(/HH:MM AM\/PM/g, 'HH:MM')
                .replace(/HH:MM/g, 'HH:MM');
        } else {
            // Target: DD/MM/YYYY, HH:MM AM/PM (12h)
            result = result
                .replace(/Day ([1-9])/g, '0$1/01/2026')
                .replace(/Day N/g, 'DD/MM/YYYY')
                .replace(/Day X/g, 'DD/MM/YYYY')
                .replace(/Day 0/g, '31/12/2025')
                .replace(/14:00/g, '02:00 PM')
                .replace(/22:00/g, '10:00 PM')
                .replace(/10:42/g, '10:42 AM')
                .replace(/10:44/g, '10:44 AM')
                .replace(/HH:MM/g, 'HH:MM AM/PM')
                .replace(/HH:MM AM\/PM/g, 'HH:MM AM/PM');
        }
    } else {
        if (is24h) {
            // Target: Day N, HH:MM (24h)
            result = result
                .replace(/0([1-9])\/01\/2026/g, 'Day $1')
                .replace(/DD\/MM\/YYYY/g, 'Day N')
                .replace(/31\/12\/2025/g, 'Day 0')
                .replace(/12:15 AM/g, '00:15')
                .replace(/11:52 AM/g, '11:52')
                .replace(/10:00 PM/g, '22:00')
                .replace(/08:00 AM/g, '08:00')
                .replace(/06:00 PM/g, '18:00')
                .replace(/14:00/g, '14:00')
                .replace(/10:42/g, '10:42')
                .replace(/10:44/g, '10:44')
                .replace(/HH:MM AM\/PM/g, 'HH:MM')
                .replace(/HH:MM/g, 'HH:MM');
        } else {
            // Target: Day N, HH:MM AM/PM (12h)
            result = result
                .replace(/0([1-9])\/01\/2026/g, 'Day $1')
                .replace(/DD\/MM\/YYYY/g, 'Day N')
                .replace(/31\/12\/2025/g, 'Day 0')
                .replace(/14:00/g, '02:00 PM')
                .replace(/22:00/g, '10:00 PM')
                .replace(/10:42/g, '10:42 AM')
                .replace(/10:44/g, '10:44 AM')
                .replace(/HH:MM/g, 'HH:MM AM/PM')
                .replace(/HH:MM AM\/PM/g, 'HH:MM AM/PM');
        }
    }

    return result;
}

/**
 * Iterates through all stored system prompt, modular agent prompt, and stock prompt templates,
 * rewriting their embedded date/time examples to match the newly selected format.
 * @param {object} settings
 */
export function adjustAllStoredTemplatesForTimeFormat(settings) {
    if (settings.routerSystemPromptTemplate) {
        settings.routerSystemPromptTemplate = adjustPromptTimestamps(settings.routerSystemPromptTemplate, settings);
    }
    if (settings.routerModularPromptTemplate) {
        settings.routerModularPromptTemplate = adjustPromptTimestamps(settings.routerModularPromptTemplate, settings);
    }
    if (settings.stockPrompts) {
        for (const [key, val] of Object.entries(settings.stockPrompts)) {
            settings.stockPrompts[key] = adjustPromptTimestamps(val, settings);
        }
    }
}
