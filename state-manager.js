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
import { bindGetSettings } from './src/state/settings-ref.js';
import { DEFAULT_NPC_SECTIONS, DEFAULT_PC_SECTIONS, MODULE_NAME } from './src/state/schema-sections.js';
import { getNpcRelationshipMax } from './src/state/relationship-math.js';
import {
    getDefaultPortraitLocationSystemPrompt,
    isShippedPortraitLocationSystemPrompt,
    PORTRAIT_LOCATION_SYSTEM_PROMPT_WITH_NPCS,
    PORTRAIT_LOCATION_SYSTEM_PROMPT_WITH_NPCS_V1,
} from './src/state/portrait-prompts.js';
import { buildNpcInstruction, buildLocInstruction, buildFacInstruction } from './src/state/module-instructions.js';
import { DEFAULT_MODULES } from './src/state/default-modules.js';
import { buildDefaultSettings, FACTORY_SETTINGS_VERSION } from './src/state/defaults.js';
import { isOlderThan } from './src/state/versions.js';

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

// Leaf modules call getSettings via settings-ref; bind before any getSettings use.
bindGetSettings(getSettings);

// ── Core settings accessor ─────────────────────────────────────────────────────

/**
 * Returns the live extension settings object, deep-merging defaults for any
 * missing keys. All reads and writes to persistent state go through this.
 * @returns {Record<string, any>}
 */
// compareVersions / isOlderThan — imported (and re-exported) from src/state/versions.js

// Re-entrancy guard: some migration blocks below call buildNpcInstruction()/
// buildLocInstruction()/buildFacInstruction(), which themselves call
// getSettings() to read a couple of flags (useDdMmYyFormat, npcRelationshipBars).
// Without this guard, a fresh install (no settingsVersion yet) re-enters
// getSettings() from inside itself before settingsVersion has been bumped,
// re-running the same migration block over and over → infinite recursion /
// stack overflow that hangs the page on load. See CHANGELOG for details.
let _gettingSettings = false;

export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();

    // Re-entrant call from within a migration block (e.g. via one of the
    // instruction builders) — just hand back the in-progress settings object
    // rather than re-running the merge/migration pipeline recursively.
    if (_gettingSettings) {
        return extensionSettings[MODULE_NAME] || (extensionSettings[MODULE_NAME] = {});
    }
    _gettingSettings = true;
    try {
        return getSettingsInternal(extensionSettings);
    } finally {
        _gettingSettings = false;
    }
}

function getSettingsInternal(extensionSettings) {
    const defaults = buildDefaultSettings();

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = {};
    }

    // Deep merge — fills in missing keys without overwriting existing ones
    for (const [key, value] of Object.entries(defaults)) {
        if (extensionSettings[MODULE_NAME][key] === undefined) {
            extensionSettings[MODULE_NAME][key] = value;
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            if (extensionSettings[MODULE_NAME][key] === undefined) extensionSettings[MODULE_NAME][key] = {};
            for (const [subKey, subValue] of Object.entries(value)) {
                if (extensionSettings[MODULE_NAME][key][subKey] === undefined) {
                    extensionSettings[MODULE_NAME][key][subKey] = subValue;
                }
            }
        }
    }
    
    const s = extensionSettings[MODULE_NAME];

    // Load UI collapse and open/close states from localStorage to prevent expensive saveSettings/disk I/O calls
    if (localStorage.getItem('rpg_tracker_collapsed') !== null) {
        s.trackerCollapsed = localStorage.getItem('rpg_tracker_collapsed') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_collapsed', String(s.trackerCollapsed));
    }
    if (localStorage.getItem('rpg_tracker_agent_collapsed') !== null) {
        s.agentCollapsed = localStorage.getItem('rpg_tracker_agent_collapsed') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_agent_collapsed', String(s.agentCollapsed));
    }
    if (localStorage.getItem('rpg_tracker_agent_keys_collapsed') !== null) {
        s.agentKeysCollapsed = localStorage.getItem('rpg_tracker_agent_keys_collapsed') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_agent_keys_collapsed', String(s.agentKeysCollapsed));
    }
    if (localStorage.getItem('rpg_tracker_rendered_view_active') !== null) {
        s.renderedViewActive = localStorage.getItem('rpg_tracker_rendered_view_active') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_rendered_view_active', String(s.renderedViewActive));
    }
    if (localStorage.getItem('rpg_tracker_agent_settings_open') !== null) {
        s.agentSettingsOpen = localStorage.getItem('rpg_tracker_agent_settings_open') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_agent_settings_open', String(s.agentSettingsOpen));
    }
    if (localStorage.getItem('rpg_tracker_agent_modules_open') !== null) {
        s.agentModulesOpen = localStorage.getItem('rpg_tracker_agent_modules_open') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_agent_modules_open', String(s.agentModulesOpen));
    }
    if (localStorage.getItem('rpg_tracker_agent_console_open') !== null) {
        s.agentConsoleOpen = localStorage.getItem('rpg_tracker_agent_console_open') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_agent_console_open', String(s.agentConsoleOpen));
    }
    if (localStorage.getItem('rpg_tracker_agent_world_open') !== null) {
        s.agentWorldOpen = localStorage.getItem('rpg_tracker_agent_world_open') === 'true';
    } else {
        localStorage.setItem('rpg_tracker_agent_world_open', String(s.agentWorldOpen));
    }
    if (localStorage.getItem('rpg_tracker_content_mode') !== null) {
        const mode = localStorage.getItem('rpg_tracker_content_mode');
        s.trackerContentMode = mode === 'agent' ? 'agent' : 'tracker';
    } else if (localStorage.getItem('rpg_tracker_agent_visible') === 'true') {
        s.trackerContentMode = 'agent';
        localStorage.setItem('rpg_tracker_content_mode', 'agent');
        localStorage.removeItem('rpg_tracker_agent_visible');
    } else {
        localStorage.setItem('rpg_tracker_content_mode', s.trackerContentMode || 'tracker');
    }

    // ── MIGRATION: CYOA slot type `roll` removed — map to narrative ────────────
    if (Array.isArray(s.cyoaConfig?.slots)) {
        for (const slot of s.cyoaConfig.slots) {
            if (slot?.type === 'roll') slot.type = 'narrative';
        }
    }
    if (s.cyoaConfig?.presets && typeof s.cyoaConfig.presets === 'object') {
        for (const presetSlots of Object.values(s.cyoaConfig.presets)) {
            if (!Array.isArray(presetSlots)) continue;
            for (const slot of presetSlots) {
                if (slot?.type === 'roll') slot.type = 'narrative';
            }
        }
    }
    // Older builds always persisted customPromptText on CYOA save even when the user
    // never opted into a custom prompt — that froze CYOA through Main System Prompt updates.
    // Unless useCustomPrompt is explicitly true, the builder is source of truth.
    if (s.cyoaConfig && s.cyoaConfig.useCustomPrompt !== true && s.cyoaConfig.customPromptText) {
        s.cyoaConfig.customPromptText = '';
    }
    
    // ── MIGRATION: routerModules (v1.8.35+) ───────────────────────────────────

    if (s.routerModules && typeof s.routerModules.npc === 'boolean') {
        const old = s.routerModules;
        s.routerModules = {
            npc: { enabled: !!old.npc, tag: 'NPC', format: 'Name | Description | Keywords', instruction: DEFAULT_MODULES.npc.instruction },
            loc: { enabled: !!old.loc, tag: 'LOC', format: 'Name | Description | Keywords', instruction: 'Named places. Name MUST be the full hierarchical path using " :: " as the separator (e.g. "Khelt :: Rust-Lantern District :: Marrow-Deep Mines Office"). Include each ancestor as a keyword.' },
            fac: { enabled: !!old.fac, tag: 'FAC', format: 'Name | Status | Description | Keywords', instruction: 'Named factions, guilds, organisations. **Status**: short current-state line. **Description**: longer narrative (history, schemes, members). **Keywords**: comma-separated terms.' },
            quest: { enabled: !!old.quest, tag: 'QUEST', format: 'Name | Location | Description | Keywords', instruction: 'ONLY record a quest if the player unambiguously begins to pursue a quest. A quest being mentioned, offered, or entertained by the player is NOT enough.' },
            event: { enabled: !!old.event, tag: 'EVENT', format: 'Name | Details | Keywords', instruction: 'Significant narrative events. Use a SHORT, STABLE Name — no timestamps in the name. Reuse the exact same Name when adding new information.' },
            world: { enabled: !!old.world, tag: 'WORLD', format: 'Name | Details | Keywords', instruction: DEFAULT_MODULES.world.instruction }
        };
    }

    // ── MIGRATION: routerModules.world.enabled → worldProgressionEnabled (v2.x+) ──────
    // The World Progression system is a standalone deterministic pass. If a user had the
    // old module toggle enabled, migrate that intent and disable the legacy module toggle.
    if (s.routerModules?.world?.enabled && !s.worldProgressionEnabled) {
        s.worldProgressionEnabled = true;
        s.routerModules.world.enabled = false;
    }
    // ── MIGRATION: worldEngine* → worldProgression* (v2.x rename) ────────────────────
    if (s.worldEngineEnabled !== undefined && s.worldProgressionEnabled === false) {
        s.worldProgressionEnabled = !!s.worldEngineEnabled;
        delete s.worldEngineEnabled;
    }
    if (s.worldEngineIntervalHours !== undefined) { s.worldProgressionIntervalHours = s.worldEngineIntervalHours; delete s.worldEngineIntervalHours; }
    if (s.worldEngineKeepActive !== undefined) { s.worldProgressionKeepActive = s.worldEngineKeepActive; delete s.worldEngineKeepActive; }
    if (s.worldEngineLastFiredAtMinutes !== undefined) { s.worldProgressionLastFiredAtMinutes = s.worldEngineLastFiredAtMinutes; delete s.worldEngineLastFiredAtMinutes; }
    if (s.worldEngineLastFiredPeriodLabel !== undefined) { s.worldProgressionLastFiredPeriodLabel = s.worldEngineLastFiredPeriodLabel; delete s.worldEngineLastFiredPeriodLabel; }

    // FAC tag: 3-field format -> 4-field (v2.2.3+) so Status and Description are separate prompts to the model
    if (s.routerModules?.fac?.format === 'Name | Description | Keywords') {
        s.routerModules.fac.format = DEFAULT_MODULES.fac.format;
    }

    // Ensure all stock modules have a format field (in case of old saves missing it)
    for (const [key, def] of Object.entries(DEFAULT_MODULES)) {
        if (s.routerModules?.[key] && !s.routerModules[key].format) {
            s.routerModules[key].format = def.format;
        }
    }

    // Ensure all custom tags have a format field
    if (Array.isArray(s.routerCustomTags)) {
        for (const ct of s.routerCustomTags) {
            if (!ct.format) ct.format = 'Name | Description | Keywords';
        }
    }

    // Strip legacy NPC line about State Memo (tracker memo UI is optional / unused in many setups)
    if (s.routerModules?.npc?.instruction && typeof s.routerModules.npc.instruction === 'string') {
        let ins = s.routerModules.npc.instruction;
        if (/their state lives in the State Memo/i.test(ins)) {
            ins = ins.replace(/\s*[\u2014\u2013-]\s*their state lives in the State Memo\.?\s*/gi, '. ');
            ins = ins.replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();
            s.routerModules.npc.instruction = ins;
        }
    }

    // Migrate NPC prompt to include appearance recording (v3.5.2 one-time migration)
    if (isOlderThan(s.settingsVersion, '3.5.2')) {
        if (s.routerModules?.npc?.instruction === 'Named characters. Do NOT create an entry for {{user}}. Mention {{user}} in EVENT or QUEST entries as needed.') {
            s.routerModules.npc.instruction = DEFAULT_MODULES.npc.instruction;
        }
        s.settingsVersion = '3.5.2';
    }

    // Migrate NPC prompt to include Friendship/Affection relationship tracking (v3.6.0)
    if (isOlderThan(s.settingsVersion, '3.6.0')) {
        if (s.routerModules?.npc?.instruction && typeof s.routerModules.npc.instruction === 'string') {
            const ins = s.routerModules.npc.instruction;
            // Only migrate if it doesn't already mention Friendship/Rapport
            if (!ins.includes('Friendship/Rapport')) {
                s.routerModules.npc.instruction = ins.trimEnd() + ' At the end of every NPC entry, always include these two relationship metrics on separate lines:\nFriendship/Rapport: 0/100\nAffection/Interest: 0/100\nThese values CAN be negative (e.g., -45/100) representing hostility or disgust. Range: -100 to 100. Start new NPCs at 0/100 for both. Update as interactions warrant.';
            }
        }
        s.settingsVersion = '3.6.0';
    }

    // Migrate NPC prompt to structured sections format (v3.7.0)
    if (isOlderThan(s.settingsVersion, '3.7.0')) {
        if (s.routerModules?.npc?.instruction && typeof s.routerModules.npc.instruction === 'string') {
            // Replace wholesale — the new format is significantly different
            s.routerModules.npc.instruction = DEFAULT_MODULES.npc.instruction;
        }
        s.settingsVersion = '3.7.0';
    }

    // Migrate NPC prompt — fix sections-outside-tags issue + remove sentence counts (v3.8.0)
    if (isOlderThan(s.settingsVersion, '3.8.0')) {
        if (s.routerModules?.npc?.instruction && typeof s.routerModules.npc.instruction === 'string') {
            s.routerModules.npc.instruction = DEFAULT_MODULES.npc.instruction;
        }
        s.settingsVersion = '3.8.0';
    }

    // Migrate NPC prompt — tighter token defaults + conciseness emphasis (v3.9.0)
    if (isOlderThan(s.settingsVersion, '3.9.0')) {
        if (s.routerModules?.npc?.instruction && typeof s.routerModules.npc.instruction === 'string') {
            s.routerModules.npc.instruction = DEFAULT_MODULES.npc.instruction;
        }
        s.settingsVersion = '3.9.0';
    }

    // Migrate NPC prompt — relationship bars off by default + settings-driven instruction (v3.10.0)
    if (isOlderThan(s.settingsVersion, '3.10.0')) {
        // Ensure NPC settings exist with defaults
        if (s.npcMajorTokens === undefined) s.npcMajorTokens = 125;
        if (s.npcMinorTokens === undefined) s.npcMinorTokens = 100;
        if (s.npcRelationshipBars === undefined) s.npcRelationshipBars = false;
        // Rebuild instruction from current settings
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorTokens, s.npcMinorTokens);
        }
        s.settingsVersion = '3.10.0';
    }

    // Migrate NPC system to [CORE] tag, code-owned relationship bars, and delta-based updates (v3.11.0)
    if (isOlderThan(s.settingsVersion, '3.11.0')) {
        // Initialize relationship value store
        if (!s.npcRelationshipValues) s.npcRelationshipValues = {};
        // Force-rebuild NPC instruction to new format
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(
                s.npcMajorTokens ?? 125,
                s.npcMinorTokens ?? 100
            );
        }
        s.settingsVersion = '3.11.0';
    }

    // Migrate NPC limits from tokens to words (v3.12.0)
    if (isOlderThan(s.settingsVersion, '3.12.0')) {
        // Convert old token keys to word keys using approximate conversion (125t→90w, 100t→60w)
        if (s.npcMajorWords === undefined) {
            s.npcMajorWords = s.npcMajorTokens !== undefined ? Math.round(s.npcMajorTokens * 0.72) : 25;
        }
        if (s.npcMinorWords === undefined) {
            s.npcMinorWords = s.npcMinorTokens !== undefined ? Math.round(s.npcMinorTokens * 0.72) : 15;
        }
        // Rebuild instruction with word-based limits
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords);
        }
        s.settingsVersion = '3.12.0';
    }

    // Migrate NPC limits from total words to per-section word targets (v3.13.0)
    if (isOlderThan(s.settingsVersion, '3.13.0')) {
        // Convert old total word limits (90/60) to reasonable per-section defaults (25/15).
        // Only reset clearly legacy token-era values — NOT arbitrary high word counts.
        // Threshold raised to 1000 so users can freely set values like 200, 300, 400+.
        if (s.npcMajorWords === 90 || s.npcMajorWords > 1000) {
            s.npcMajorWords = 25;
        }
        if (s.npcMinorWords === 60 || s.npcMinorWords > 1000) {
            s.npcMinorWords = 15;
        }
        // Rebuild instruction with new length target wording
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords);
        }
        s.settingsVersion = '3.13.0';
    }

    // Wrap CORE_FORMAT and CORE LENGTH TARGETS in XML tags (v3.14.0)
    if (isOlderThan(s.settingsVersion, '3.14.0')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords);
        }
        s.settingsVersion = '3.14.0';
    }

    // Ensure entry starts directly with [CORE] and add relationship editing (v3.15.0)
    if (isOlderThan(s.settingsVersion, '3.15.0')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords);
        }
        s.settingsVersion = '3.15.0';
    }

    // Enforce {{user}} macro usage and prevent literal "user" or "player" text (v3.16.0)
    if (isOlderThan(s.settingsVersion, '3.16.0')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords);
        }
        s.systemPromptTemplate = defaults.systemPromptTemplate;
        s.settingsVersion = '3.16.0';
    }

    // Reinforce NPC and Event prompts regarding combat granularity and logs (v3.16.13)
    if (isOlderThan(s.settingsVersion, '3.16.13')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords);
        }
        if (s.routerModules?.event) {
            s.routerModules.event.instruction = DEFAULT_MODULES.event.instruction;
        }
        s.routerSystemPromptTemplate = defaults.routerSystemPromptTemplate;
        s.settingsVersion = '3.16.13';
    }

    // Expand NPC relationship delta guidance with situational examples (v3.16.14)
    if (isOlderThan(s.settingsVersion, '3.16.14')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords);
        }
        // Add default settings for Auto-Generate NPC portraits (upstream)
        if (s.portraitAutoGenerateNpcs === undefined) {
            s.portraitAutoGenerateNpcs = false;
        }
        s.settingsVersion = '3.16.14';
    }

    // Reinforce that NPC Description must start directly with [CORE] without timestamp (v3.16.16)
    if (isOlderThan(s.settingsVersion, '3.16.16')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords, false);
        }
        s.settingsVersion = '3.16.16';
    }

    // Move ongoing relationship tracking from lorebook agent to narrative AI direct parsing (v3.16.17)
    if (isOlderThan(s.settingsVersion, '3.16.17')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords, false);
        }
        s.settingsVersion = '3.16.17';
    }

    // Force rebuild of NPC instruction to restore length targets that were incorrectly stripped by a previous bug (v3.16.18)
    if (isOlderThan(s.settingsVersion, '3.16.18')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords, false);
        }
        s.settingsVersion = '3.16.18';
    }

    // Tighten perennial [CORE] guidance — ban plot-tied scene recaps (v3.16.19)
    if (isOlderThan(s.settingsVersion, '3.16.19')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords, false);
        }
        s.settingsVersion = '3.16.19';
    }

    // Baseline since-last-run watermark after lookback reliability fix (v3.16.20)
    if (isOlderThan(s.settingsVersion, '3.16.20')) {
        s.routerWatermarkBaselinePending = true;
        s.settingsVersion = '3.16.20';
    }

    // NPC portrait card view toggle (v3.16.21)
    if (isOlderThan(s.settingsVersion, '3.16.21')) {
        if (s.npcPortraits === undefined) s.npcPortraits = true;
        if (s.locationImages === undefined) s.locationImages = false;
        if (s.portraitAutoGenerateLocations === undefined) s.portraitAutoGenerateLocations = false;
        s.settingsVersion = '3.16.21';
    }

    // Quest archive UI toggle default (v3.16.22)
    if (isOlderThan(s.settingsVersion, '3.16.22')) {
        if (s.syspromptModules && s.syspromptModules.questsShowArchive === undefined) {
            s.syspromptModules.questsShowArchive = true;
        }
        s.settingsVersion = '3.16.22';
    }

    // LOC module: plain [CORE] without NPC field headers (v4.3.9)
    if (isOlderThan(s.settingsVersion, '4.3.9')) {
        if (s.routerModules?.loc) {
            s.routerModules.loc.instruction = buildLocInstruction();
        }
        s.settingsVersion = '4.3.9';
    }

    // NPC relationship max: global default + per-chat live value (v4.4.0)
    if (isOlderThan(s.settingsVersion, '4.4.0')) {
        if (s.npcRelationshipMaxDefault === undefined) {
            s.npcRelationshipMaxDefault = s.npcRelationshipMax ?? 150;
        }
        if (s.npcRelationshipMax === undefined) {
            s.npcRelationshipMax = s.npcRelationshipMaxDefault;
        }
        s.settingsVersion = '4.4.0';
    }

    // Hardened player safeguard prompts & Faction [CORE] tags (v4.5.0)
    if (isOlderThan(s.settingsVersion, '4.5.0')) {
        if (s.routerModules?.npc) {
            s.routerModules.npc.instruction = buildNpcInstruction(s.npcMajorWords, s.npcMinorWords, false);
        }
        if (s.routerModules?.loc) {
            s.routerModules.loc.instruction = buildLocInstruction();
        }
        if (s.routerModules?.fac) {
            s.routerModules.fac.instruction = buildFacInstruction();
        }
        s.routerSystemPromptTemplate = defaults.routerSystemPromptTemplate;
        s.routerModularPromptTemplate = defaults.routerModularPromptTemplate;
        s.settingsVersion = '4.5.0';
    }

    // ── MIGRATION: Update system prompts with keywords instructions (v3.2.3+) ──────
    if (s.routerSystemPromptTemplate && !s.routerSystemPromptTemplate.includes('IMPORTANT FOR KEYWORDS')) {
        if (s.routerSystemPromptTemplate.includes('<formatting>')) {
            s.routerSystemPromptTemplate = s.routerSystemPromptTemplate.replace(
                'Correct examples:',
                '- **IMPORTANT FOR KEYWORDS (KEYS):** Always include the entity\'s own name/title (without any timestamps like "Day 1", "Day 2", "12:15 AM", etc.) in the list of keywords. The title itself (stripped of timestamps) is the most reliable trigger, so it must be present as a keyword. For example, if the entry title is "[12:15 AM, Day 2] Defense of Ironbelly\'s Workshop", the keys list MUST include "Defense of Ironbelly\'s Workshop".\n\nCorrect examples:'
            );
        }
    }
    if (s.routerModularPromptTemplate && !s.routerModularPromptTemplate.includes('IMPORTANT FOR KEYWORDS')) {
        if (s.routerModularPromptTemplate.includes('NPC / FAC / QUEST / EVENT labels:')) {
            s.routerModularPromptTemplate = s.routerModularPromptTemplate.replace(
                'NPC / FAC / QUEST / EVENT labels:',
                '**IMPORTANT FOR KEYWORDS:** Always include the entry\'s own title/name (without any timestamps like "Day 1", "Day 2", "12:15 AM", etc.) in the keywords field. The title itself (stripped of timestamps) is the most reliable trigger, so it must be present as a keyword. For example, for a tag representing a "Defense of Ironbelly\'s Workshop" event, the keywords MUST contain "Defense of Ironbelly\'s Workshop".\n\nNPC / FAC / QUEST / EVENT labels:'
            );
        }
    }

    // ── MIGRATION: Ban {{user}}/{{char}} from keywords/keys in existing templates (v3.16.19+) ──────
    if (s.routerSystemPromptTemplate && !s.routerSystemPromptTemplate.includes('DO NOT INCLUDE `{{user}}`')) {
        if (s.routerSystemPromptTemplate.includes('the keys list MUST include "Defense of Ironbelly\'s Workshop".')) {
            s.routerSystemPromptTemplate = s.routerSystemPromptTemplate.replace(
                'the keys list MUST include "Defense of Ironbelly\'s Workshop".',
                'the keys list MUST include "Defense of Ironbelly\'s Workshop".\n- **DO NOT INCLUDE `{{user}}`, `{{char}}`, or general player references** in the keyword list (`keys`). The user/player is present in all events/locations, so including them as a keyword causes false matches and wastes context tokens.'
            );
        }
    }
    if (s.routerModularPromptTemplate && !s.routerModularPromptTemplate.includes('DO NOT INCLUDE `{{user}}`')) {
        if (s.routerModularPromptTemplate.includes('keywords MUST contain "Defense of Ironbelly\'s Workshop".')) {
            s.routerModularPromptTemplate = s.routerModularPromptTemplate.replace(
                'keywords MUST contain "Defense of Ironbelly\'s Workshop".',
                'keywords MUST contain "Defense of Ironbelly\'s Workshop". DO NOT INCLUDE `{{user}}`, `{{char}}`, or general player references in the keywords field — the player is present in all events and locations, so tagging them is redundant and wastes context tokens.'
            );
        }
    }

    // ── MIGRATION: Update World Progression System Prompt with Quests/Events rule (v3.4.4+) ──────
    if (s.worldProgressionSystemPrompt && !s.worldProgressionSystemPrompt.includes('QUESTS and EVENTS are historical records')) {
        s.worldProgressionSystemPrompt = s.worldProgressionSystemPrompt.replace(
            '1. Do NOT summarize player actions. Build consequences from them instead — defeated rivals plot revenge, sympathetic contacts cover their tracks, encountered strangers react to what happened.',
            '1. Do NOT summarize player actions. Build consequences from them instead — defeated rivals plot revenge, sympathetic contacts cover their tracks, encountered strangers react to what happened.\n2. QUESTS and EVENTS are historical records for context only — they are NOT simulatable entities. Never generate entries that describe a quest advancing, stalling, succeeding, or failing. If a quest appears in the designated entities block, ignore it entirely.'
        );
        s.worldProgressionSystemPrompt = s.worldProgressionSystemPrompt
            .replace('2. Prioritize named ACTIVE WORLD LORE NPCs.', '3. Prioritize named ACTIVE WORLD LORE NPCs.')
            .replace('3. For NPCs who were physically present', '4. For NPCs who were physically present')
            .replace('4. Format as 15 short entries', '5. Format as 15 short entries')
            .replace('5. Output ONLY the report content.', '6. Output ONLY the report content.')
            .replace('6. Do not simply repeat the same entities', '7. Do not simply repeat the same entities')
            .replace('7. DO NOT write a cumulative report', '8. DO NOT write a cumulative report')
            .replace('8. Cross-category entity bleeding is desirable', '9. Cross-category entity bleeding is desirable')
            .replace('9. You must strictly respect geographical', '10. You must strictly respect geographical')
            .replace('10. Character vectors must take place', '11. Character vectors must take place');
    }
 
    // ── MIGRATION: Update World Progression System Prompt with bullet-pointed and blank line rules ──
    if (s.worldProgressionSystemPrompt && !s.worldProgressionSystemPrompt.includes('Do NOT prefix the lines with the period or time label')) {
        // Replace from original or intermediate form
        s.worldProgressionSystemPrompt = s.worldProgressionSystemPrompt
            .replace(
                '5. Format as 15 short entries, 1 sentence each. Dense, no filler, no markdown.',
                '5. Format as 15 bullet-pointed entries (using "- "), with a blank line (newline) between each world event. Dense, no filler, no markdown. Each entry must be exactly 1 sentence. Do NOT prefix the lines with the period or time label.'
            )
            .replace(
                '5. Format as 15 bullet-pointed entries (using "- [{periodLabel}] Event Description..."), with a blank line (newline) between each world event. Dense, no filler, no markdown. Each entry must be exactly 1 sentence.',
                '5. Format as 15 bullet-pointed entries (using "- "), with a blank line (newline) between each world event. Dense, no filler, no markdown. Each entry must be exactly 1 sentence. Do NOT prefix the lines with the period or time label.'
            );
    }

    // ── MIGRATION: strip global UI prefs out of chatStates (Chat Link clobber fix) ─
    stripChatStateGlobalUiPrefs(s);

    // NOTE: Do NOT sniff-and-replace stockPrompts here on every getSettings().
    // That wiped themed/custom module prompts (e.g. 40k COMBAT). Stock / tracker /
    // sysprompt / agent prompt upgrades run ONLY via the post-update "Prompt Defaults
    // Updated" dialog (or Auto-Update Prompts on Upgrade) — once per fingerprint change.

    // ── MIGRATION: Block RELATIONSHIPS section in State Tracker core prompt ───────
    if (s.systemPromptTemplate) {
        if (s.systemPromptTemplate.includes('Never track relationships or reputation')) {
            s.systemPromptTemplate = s.systemPromptTemplate.replace(
                'NO RELATIONSHIPS: Never track relationships or reputation, and never create a relationship or reputation section (e.g., [RELATIONSHIPS] or [REPUTATION]). NPC relationships are handled by a separate, dedicated system.',
                'NO RELATIONSHIPS: Never track relationships, and never create a relationship section (e.g., [RELATIONSHIPS]). NPC relationships are handled by a separate, dedicated system.'
            );
        }
        if (!s.systemPromptTemplate.includes('NO RELATIONSHIPS')) {
            if (s.systemPromptTemplate.includes('DELETION: To REMOVE a section entirely, you MUST output: `[TAG]REMOVED[/TAG]`.')) {
                s.systemPromptTemplate = s.systemPromptTemplate.replace(
                    'DELETION: To REMOVE a section entirely, you MUST output: `[TAG]REMOVED[/TAG]`.',
                    'DELETION: To REMOVE a section entirely, you MUST output: `[TAG]REMOVED[/TAG]`.\nNO RELATIONSHIPS: Never track relationships, and never create a relationship section (e.g., [RELATIONSHIPS]). NPC relationships are handled by a separate, dedicated system.'
                );
            } else if (s.systemPromptTemplate.includes('DELETION: To REMOVE a section entirely, you MUST output: \\`[TAG]REMOVED[/TAG]\\`.')) {
                s.systemPromptTemplate = s.systemPromptTemplate.replace(
                    'DELETION: To REMOVE a section entirely, you MUST output: \\`[TAG]REMOVED[/TAG]\\`.',
                    'DELETION: To REMOVE a section entirely, you MUST output: \\`[TAG]REMOVED[/TAG]\\`.\nNO RELATIONSHIPS: Never track relationships, and never create a relationship section (e.g., [RELATIONSHIPS]). NPC relationships are handled by a separate, dedicated system.'
                );
            }
        }
    }

    // Location scene prompt defaults: keep textarea variant aligned with present-NPC toggle (v5.5.6+)
    // 5.5.7 also migrates the original 5.5.0 "establishing shot" factory text.
    if (isOlderThan(s.settingsVersion, '5.5.7')) {
        if (isShippedPortraitLocationSystemPrompt(s.portraitLocationSystemPrompt || '')) {
            s.portraitLocationSystemPrompt = getDefaultPortraitLocationSystemPrompt(!!s.portraitLocationIncludePresentNpcs);
        }
        s.settingsVersion = '5.5.7';
    }

    // 5.5.8: refresh WITH_NPCS factory prompt (minor narrative characters line).
    if (isOlderThan(s.settingsVersion, '5.5.8')) {
        const norm = (v) => (v || '').replace(/\r\n/g, '\n').trim();
        const prompt = norm(s.portraitLocationSystemPrompt);
        if (s.portraitLocationIncludePresentNpcs && (
            prompt === norm(PORTRAIT_LOCATION_SYSTEM_PROMPT_WITH_NPCS_V1)
            || prompt === norm(PORTRAIT_LOCATION_SYSTEM_PROMPT_WITH_NPCS)
        )) {
            s.portraitLocationSystemPrompt = PORTRAIT_LOCATION_SYSTEM_PROMPT_WITH_NPCS;
        }
        s.settingsVersion = '5.5.8';
    }

    if (isOlderThan(s.settingsVersion, '5.5.9')) {
        if (s.portraitRegenerateVisitedLocations === undefined) {
            s.portraitRegenerateVisitedLocations = false;
        }
        s.settingsVersion = '5.5.9';
    }

    // 5.5.10: Real-Time Mode vs Lorebook Locations auto-gen are mutually exclusive.
    // Prefer Real-Time Mode when both were previously enabled (avoids agent overwriting arrival art).
    if (isOlderThan(s.settingsVersion, '5.5.10')) {
        if (s.portraitAutoGenerateSceneView && s.portraitAutoGenerateLocations) {
            s.portraitAutoGenerateLocations = false;
        }
        if (!s.portraitAutoGenerateSceneView) {
            s.portraitRegenerateVisitedLocations = false;
        }
        s.settingsVersion = '5.5.10';
    }

    // 5.5.11: Real-Time Mode forces its companion location portrait options on.
    if (isOlderThan(s.settingsVersion, '5.5.11')) {
        if (s.portraitAutoGenerateSceneView) {
            s.portraitRegenerateVisitedLocations = true;
            s.locationImages = true;
            s.portraitLocationIncludePresentNpcs = true;
            s.portraitAutoGenerateLocations = false;
            if (isShippedPortraitLocationSystemPrompt(s.portraitLocationSystemPrompt || '')) {
                s.portraitLocationSystemPrompt = getDefaultPortraitLocationSystemPrompt(true);
            }
        }
        s.settingsVersion = '5.5.11';
    }

    // 5.5.12: Location images alpha — opt-in only (default off).
    if (isOlderThan(s.settingsVersion, '5.5.12')) {
        s.settingsVersion = '5.5.12';
    }

    // 5.5.13: Real-Time Visualization trigger modes (enter / change / every N outputs).
    if (isOlderThan(s.settingsVersion, '5.5.13')) {
        if (!s.portraitRealtimeTriggerMode) {
            // Preserve prior Real-Time behavior: regenerate on each location change/revisit.
            s.portraitRealtimeTriggerMode = 'location_change';
        }
        if (s.portraitRealtimeEveryNOutputs == null || Number(s.portraitRealtimeEveryNOutputs) < 1) {
            s.portraitRealtimeEveryNOutputs = 1;
        }
        s.settingsVersion = '5.5.13';
    }

    // ── MIGRATION: Auto-fix legacy corrupted PC Core Section colors ────────────────
    if (s.pcCoreSections && Array.isArray(s.pcCoreSections) && s.pcCoreSections.length === 6) {
        // We check by ID rather than name, because the legacy version might have had "Appearance" instead of "Appearance/Species"
        const idsMatch = s.pcCoreSections.every((sec, idx) => sec.id === DEFAULT_PC_SECTIONS[idx].id);
        const colorsMatch = s.pcCoreSections.every((sec, idx) => sec.color === DEFAULT_PC_SECTIONS[idx].color);
        if (idsMatch && !colorsMatch) {
            s.pcCoreSections.forEach((sec, idx) => {
                sec.color = DEFAULT_PC_SECTIONS[idx].color;
            });
        }
    }

    return extensionSettings[MODULE_NAME];
}

// ── Bar color resolver ─────────────────────────────────────────────────────────

/**
 * Returns the CSS background string for a bar element, respecting any
 * user-configured color overrides stored in settings.barColors.
 * @param {string} barId
 * @param {string} defaultBackground
 * @param {number|null} pct
 */
export function getBarBackground(barId, defaultBackground, pct = null) {
    if (!barId) return defaultBackground;
    const s = getSettings();
    const cfg = s.barColors?.[barId];
    if (!cfg) {
        const isHP = barId.endsWith(':HP') || barId.includes(':HPBAR');
        // Only apply automatic pct-based HP coloring when the caller hasn't supplied
        // a custom color (i.e. defaultBackground is the default HP green).
        // Explicit marker colors like ((BARRED)) or ((BARGREEN)) pass their own
        // gradient as defaultBackground — those must NOT be silently overridden.
        const DEFAULT_HP = '#00ffaa';
        if (isHP && pct !== null && (defaultBackground === DEFAULT_HP || defaultBackground == null)) {
            return pct > 60 ? '#00ffaa' : pct > 30 ? '#ffaa00' : '#ff5555';
        }
        return defaultBackground;
    }

    if (typeof cfg === 'string') return cfg; // Legacy support

    switch (cfg.mode) {
        case 'gradient':
            return `linear-gradient(90deg, ${cfg.color}, ${cfg.color2 || cfg.color})`;
        case 'dynamic': {
            const p = pct !== null ? pct : 100;
            return p > 60 ? '#00ffaa' : p > 30 ? '#ffaa00' : '#ff5555';
        }
        case 'solid':
        default:
            return cfg.color;
    }
}

/**
 * Checks if a specific bar is configured to be rendered as a percentage.
 * @param {string} barId
 * @returns {boolean}
 */
export function getBarShowAsPercentage(barId) {
    if (!barId) return false;
    const s = getSettings();
    const cfg = s.barColors?.[barId];
    if (cfg && typeof cfg === 'object') {
        return !!cfg.showAsPercentage;
    }
    return false;
}

/**
 * Sanitizes a string into a lorebook-safe campaign prefix (same rules as chat-id derive).
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeCampaignPrefixString(raw) {
    if (!raw) return '';
    return String(raw).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Prefix used for world activation and router: optional user override, else from chat id.
 * @param {string} chatId
 * @returns {string}
 */
export function getEffectiveRouterCampaignPrefix(chatId) {
    const s = getSettings();
    const ov = (s.routerCampaignPrefixOverride || '').trim();
    if (ov) return sanitizeCampaignPrefixString(ov);
    return sanitizeCampaignPrefixString(chatId || '');
}

// ── One-time data migrations ───────────────────────────────────────────────────

/**
 * Migrates custom fields from legacy formats to the current template-based format.
 * Safe to call repeatedly — idempotent.
 */
export function migrateCustomFields() {
    const s = getSettings();

    // Strip placeholder NEW_TAG entries persisted from previous sessions (one-time cleanup at init)
    if (Array.isArray(s.routerCustomTags)) {
        s.routerCustomTags = s.routerCustomTags.filter(t => t.tag && t.tag !== 'NEW_TAG');
    }

    (s.customFields || []).forEach(field => {
        // Migration 1: Convert single renderType to empty rows (old)
        if (field.renderType !== undefined && !field.rows && !field.template) {
            field.rows = [];
            delete field.renderType;
        }
        // Migration 2: Convert rows to template (New)
        if (field.rows && !field.template) {
            const UI_TO_MARKER = {
                'pills': 'PILLS', 'badge': 'BADGE', 'highlight': 'HIGHLIGHT',
                'hp_bar': 'BAR', 'xp_bar': 'XPBAR', 'text': 'TEXT', 'kv': 'TEXT'
            };
            field.template = field.rows.map(row => {
                const marker = UI_TO_MARKER[row.renderType] || 'TEXT';
                const content = row.label || '';
                return `((${marker})) ${content}`;
            }).join('\n').trim();
            delete field.rows;
            delete field.renderType;
        }
    });
}

// ── Chat-linked state persistence ─────────────────────────────────────────────

/** Active chat id — prefer tracker-tracked id over raw ST context. */
export function getActiveChatId() {
    const ctx = SillyTavern.getContext();
    const tracked = typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : null;
    return tracked || ctx.getCurrentChatId?.() || ctx.chatId || null;
}

/**
 * When Chat Link is on, restore the WP timer label from chatStates if the live
 * field was cleared (e.g. after debounced settings reload) but the partition still has it.
 * @returns {boolean} true if a label was hydrated
 */
export function hydrateWorldProgressionFromChatState() {
    const s = getSettings();
    if (!s.chatLinkEnabled) return false;
    const chatId = getActiveChatId();
    if (!chatId) return false;
    const stored = s.chatStates?.[chatId];
    if (!stored?.worldProgressionLastFiredPeriodLabel) return false;
    if (s.worldProgressionLastFiredPeriodLabel) return false;
    s.worldProgressionLastFiredPeriodLabel = stored.worldProgressionLastFiredPeriodLabel;
    return true;
}

/** Persist the WP timer to the active chat partition or global settings. */
export function persistWorldProgressionTimer() {
    const s = getSettings();
    const chatId = getActiveChatId();
    if (s.chatLinkEnabled && chatId) {
        saveChatState(chatId);
    } else {
        SillyTavern.getContext().saveSettingsDebounced();
    }
}

/** Persist the Lorebook Agent "since last run" chat-length watermark. */
export function persistRouterLastRunWatermark(length) {
    const s = getSettings();
    s.routerLastRunChatLength = length;
    const chatId = getActiveChatId();
    if (s.chatLinkEnabled && chatId) {
        saveChatState(chatId);
    } else {
        SillyTavern.getContext().saveSettingsDebounced();
    }
}

/** Persist the Lorebook Agent "last ran at" timestamp (display only — separate from the indexing watermark). */
export function persistRouterLastRunTimestamp(epochMs = Date.now()) {
    const s = getSettings();
    s.routerLastRunAt = epochMs;
    const chatId = getActiveChatId();
    if (s.chatLinkEnabled && chatId) {
        saveChatState(chatId);
    } else {
        SillyTavern.getContext().saveSettingsDebounced();
    }
}

/**
 * Sync localStorage write-ahead log for module schema (customFields / blockOrder / modules).
 * Survives F5 when the async /api/settings/save fetch is cancelled mid-reload (common when
 * editing extension code then refreshing before ST's save completes).
 */
const MODULE_SCHEMA_BACKUP_KEY = 'rpg_tracker_module_schema_backup';
/** Sync tombstones for deleted custom module tags — survives cancelled settings saves even when WAL is missing. */
const DELETED_CUSTOM_TAGS_KEY = 'rpg_tracker_deleted_custom_tags';

/**
 * @returns {string[]}
 */
function readDeletedCustomTagTombstones() {
    try {
        const raw = localStorage.getItem(DELETED_CUSTOM_TAGS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.map(t => String(t).toUpperCase()).filter(Boolean) : [];
    } catch {
        return [];
    }
}

/**
 * @param {string[]} tags
 */
function writeDeletedCustomTagTombstones(tags) {
    try {
        const uniq = [...new Set((tags || []).map(t => String(t).toUpperCase()).filter(Boolean))];
        if (uniq.length === 0) localStorage.removeItem(DELETED_CUSTOM_TAGS_KEY);
        else localStorage.setItem(DELETED_CUSTOM_TAGS_KEY, JSON.stringify(uniq));
    } catch (err) {
        console.warn('[RPG Tracker] Deleted-custom-tag tombstone write failed:', err);
    }
}

/**
 * Record custom module tags as intentionally deleted (sync localStorage).
 * @param {string|string[]} tags
 */
export function recordDeletedCustomTags(tags) {
    const add = (Array.isArray(tags) ? tags : [tags]).map(t => String(t || '').toUpperCase()).filter(Boolean);
    if (!add.length) return;
    const merged = new Set([...readDeletedCustomTagTombstones(), ...add]);
    writeDeletedCustomTagTombstones([...merged]);
}

/**
 * Clear tombstones when the user intentionally re-adds a custom tag.
 * @param {string|string[]} tags
 */
export function clearDeletedCustomTagTombstones(tags) {
    const remove = new Set((Array.isArray(tags) ? tags : [tags]).map(t => String(t || '').toUpperCase()).filter(Boolean));
    if (!remove.size) return;
    writeDeletedCustomTagTombstones(readDeletedCustomTagTombstones().filter(t => !remove.has(t)));
}

/**
 * Strip tombstoned custom modules from live settings and all chatStates partitions.
 * Call on boot before loadChatState.
 * @returns {boolean} true if anything was removed
 */
export function applyDeletedCustomTagTombstones() {
    const banned = new Set(readDeletedCustomTagTombstones());
    if (!banned.size) return false;
    const s = getSettings();
    let changed = false;

    const stripFields = (fields) => {
        if (!Array.isArray(fields)) return fields;
        const next = fields.filter(f => !banned.has(String(f?.tag || '').toUpperCase()));
        if (next.length !== fields.length) changed = true;
        return next;
    };
    const stripOrder = (order) => {
        if (!Array.isArray(order)) return order;
        const next = order.filter(t => !banned.has(String(t || '').toUpperCase()));
        if (next.length !== order.length) changed = true;
        return next;
    };

    s.customFields = stripFields(s.customFields || []);
    s.blockOrder = stripOrder(s.blockOrder || []);

    if (s.chatStates && typeof s.chatStates === 'object') {
        for (const chatId of Object.keys(s.chatStates)) {
            const part = s.chatStates[chatId];
            if (!part || typeof part !== 'object') continue;
            if (part.customFields) part.customFields = stripFields(part.customFields);
            if (part.blockOrder) part.blockOrder = stripOrder(part.blockOrder);
        }
    }

    return changed;
}

/**
 * @param {string|null|undefined} chatId
 */
export function writeModuleSchemaBackup(chatId) {
    try {
        const s = getSettings();
        const payload = {
            ts: Date.now(),
            chatId: chatId || null,
            customFields: JSON.parse(JSON.stringify(s.customFields || [])),
            blockOrder: JSON.parse(JSON.stringify(s.blockOrder || BLOCK_ORDER)),
            modules: JSON.parse(JSON.stringify(s.modules || {})),
            // Same race as customFields/blockOrder: a reload (code edit, extension
            // update, plain F5) fired before the debounced disk write landed reverts
            // these to whatever was last actually on disk. Mirror them too so edited
            // stock prompts / narrator toggles self-heal on the next boot.
            stockPrompts: JSON.parse(JSON.stringify(s.stockPrompts || {})),
            syspromptModules: JSON.parse(JSON.stringify(s.syspromptModules || {})),
            narrativePacing: s.narrativePacing || 'normal',
            cyoaConfig: JSON.parse(JSON.stringify(s.cyoaConfig || {})),
        };
        localStorage.setItem(MODULE_SCHEMA_BACKUP_KEY, JSON.stringify(payload));
    } catch (err) {
        console.warn('[RPG Tracker] Module schema backup write failed:', err);
    }
}

/**
 * Returns a local configuration backup only when it differs from disk-loaded settings.
 * The caller must ask the user before applying it.
 * @returns {object|null}
 */
export function getPendingModuleSchemaBackup() {
    try {
        const raw = localStorage.getItem(MODULE_SCHEMA_BACKUP_KEY);
        if (!raw) return null;
        const backup = JSON.parse(raw);
        if (!backup || !Array.isArray(backup.customFields) || !Array.isArray(backup.blockOrder)) return null;

        const s = getSettings();
        const liveTags = JSON.stringify((s.customFields || []).map(f => f.tag));
        const backupTags = JSON.stringify(backup.customFields.map(f => f.tag));
        const liveOrder = JSON.stringify(s.blockOrder || []);
        const backupOrder = JSON.stringify(backup.blockOrder);
        const partition = backup.chatId ? s.chatStates?.[backup.chatId] : null;
        const partTags = JSON.stringify((partition?.customFields || []).map(f => f.tag));
        const liveStockPrompts = JSON.stringify(s.stockPrompts || {});
        const backupStockPrompts = JSON.stringify(backup.stockPrompts || {});
        const liveSyspromptModules = JSON.stringify(s.syspromptModules || {});
        const backupSyspromptModules = JSON.stringify(backup.syspromptModules || {});
        const liveNarrativePacing = s.narrativePacing || 'normal';
        const backupNarrativePacing = backup.narrativePacing || 'normal';
        const liveCyoaConfig = JSON.stringify(s.cyoaConfig || {});
        const backupCyoaConfig = JSON.stringify(backup.cyoaConfig || {});
        const alreadyMatched = liveTags === backupTags && liveOrder === backupOrder
            && (!backup.chatId || partTags === backupTags)
            && (!backup.stockPrompts || liveStockPrompts === backupStockPrompts)
            && (!backup.syspromptModules || liveSyspromptModules === backupSyspromptModules)
            && liveNarrativePacing === backupNarrativePacing
            && (!backup.cyoaConfig || liveCyoaConfig === backupCyoaConfig);
        return alreadyMatched ? null : backup;
    } catch (err) {
        console.warn('[RPG Tracker] Module schema backup inspection failed:', err);
        return null;
    }
}

/**
 * Apply a previously inspected local configuration backup only after the user
 * explicitly approves restoring it over disk-loaded settings.
 * @param {string|null|undefined} preferredChatId
 * @param {object|null} backupOverride
 * @returns {boolean} true if a backup was applied
 */
export function applyModuleSchemaBackup(preferredChatId, backupOverride = null) {
    try {
        const backup = backupOverride || getPendingModuleSchemaBackup();
        if (!backup) return false;

        const s = getSettings();
        const backupNarrativePacing = backup.narrativePacing || 'normal';

        // Always restore live schema from the last known-good in-memory snapshot.
        // If the async disk write completed, this matches disk. If it was cancelled on
        // F5, this heals the resurrection of deleted modules from a stale settings.js.
        s.customFields = JSON.parse(JSON.stringify(backup.customFields));
        s.blockOrder = JSON.parse(JSON.stringify(backup.blockOrder));
        if (backup.modules && typeof backup.modules === 'object') {
            s.modules = { ...s.modules, ...JSON.parse(JSON.stringify(backup.modules)) };
        }
        if (backup.stockPrompts && typeof backup.stockPrompts === 'object') {
            s.stockPrompts = { ...s.stockPrompts, ...JSON.parse(JSON.stringify(backup.stockPrompts)) };
        }
        if (backup.syspromptModules && typeof backup.syspromptModules === 'object') {
            s.syspromptModules = { ...s.syspromptModules, ...JSON.parse(JSON.stringify(backup.syspromptModules)) };
        }
        s.narrativePacing = backupNarrativePacing;
        if (backup.cyoaConfig && typeof backup.cyoaConfig === 'object') {
            s.cyoaConfig = JSON.parse(JSON.stringify(backup.cyoaConfig));
        }

        if (backup.chatId) {
            if (!s.chatStates) s.chatStates = {};
            const existing = s.chatStates[backup.chatId] || {};
            s.chatStates[backup.chatId] = {
                ...existing,
                customFields: JSON.parse(JSON.stringify(backup.customFields)),
                blockOrder: JSON.parse(JSON.stringify(backup.blockOrder)),
                modules: backup.modules
                    ? { ...(existing.modules || {}), ...JSON.parse(JSON.stringify(backup.modules)) }
                    : existing.modules,
            };
        }

        // preferredChatId is reserved for callers that only want to heal the active chat;
        // we still repair backup.chatId's partition above so loadChatState sees good data.
        void preferredChatId;

        return true;
    } catch (err) {
        console.warn('[RPG Tracker] Module schema backup apply failed:', err);
        return false;
    }
}

/**
 * Snapshots the current live settings into chatStates[chatId].
 * Pure write — no shared mutable state, no DOM.
 * @param {string} chatId
 * @param {{ skipDiskWrite?: boolean }} [opts]
 */
/**
 * Global UI / connection prefs that must NOT live in chatStates.
 * Chat Link used to snapshot these; loadChatState then overwrote live settings on every
 * F5/code reload with a stale partition — auto-image-gen, immersion, connections, etc.
 * Memo/modules/portraits/WP timers stay per-chat; these stay global.
 */
export const CHAT_STATE_GLOBAL_UI_KEYS = [
    'portraitGeneratorSource',
    'portraitSkipPromptDialog',
    'hideImageGenToasts',
    'portraitAutoGenerateParty',
    'portraitAutoGeneratePlayer',
    'portraitAutoGenerateEnemies',
    'portraitAutoGenerateNpcs',
    'portraitAutoGenerateLocations',
    'portraitAutoGenerateSceneView',
    'portraitRealtimeTriggerMode',
    'portraitRealtimeEveryNOutputs',
    'portraitRegenerateVisitedLocations',
    'portraitLocationIncludePresentNpcs',
    'locationImages',
    'agentImmersionMode',
    'portraitConnectionSource',
    'portraitConnectionProfileId',
    'portraitCompletionPresetId',
    'portraitOllamaUrl',
    'portraitOllamaModel',
    'portraitOpenaiUrl',
    'portraitOpenaiKey',
    'portraitOpenaiModel',
    'worldConnectionSource',
    'worldConnectionProfileId',
    'worldCompletionPresetId',
    'worldOllamaUrl',
    'worldOllamaModel',
    'worldOpenaiUrl',
    'worldOpenaiKey',
    'worldOpenaiModel',
    'gameSystemWizardConnectionSource',
    'gameSystemWizardConnectionProfileId',
    'gameSystemWizardCompletionPresetId',
    'gameSystemWizardOllamaUrl',
    'gameSystemWizardOllamaModel',
    'gameSystemWizardOpenaiUrl',
    'gameSystemWizardOpenaiKey',
    'gameSystemWizardOpenaiModel',
    'gameSystemWizardSystemPrompt',
    // Appearance is global — never chat-linked (defensive; not historically snapshotted)
    'panelBgImage',
    'panelBgImageNight',
    'panelBgOverlayStrength',
    'agentPanelBgImage',
    'agentPanelBgImageNight',
    'agentPanelBgOverlayStrength',
    'dayNightCycleEnabled',
];

/** Strip global UI keys from every chatStates partition (one-shot hygiene on load/save). */
export function stripChatStateGlobalUiPrefs(settings) {
    const states = settings?.chatStates;
    if (!states || typeof states !== 'object') return false;
    let changed = false;
    for (const part of Object.values(states)) {
        if (!part || typeof part !== 'object') continue;
        for (const key of CHAT_STATE_GLOBAL_UI_KEYS) {
            if (Object.prototype.hasOwnProperty.call(part, key)) {
                delete part[key];
                changed = true;
            }
        }
    }
    return changed;
}

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
