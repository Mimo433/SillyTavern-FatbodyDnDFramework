/**
 * Vitest setup — mocks host APIs before state-manager (and friends) load.
 * DEFAULT_MODULES init calls buildNpcInstruction() → getSettings() → SillyTavern.getContext().
 */

const localStore = Object.create(null);

globalThis.localStorage = {
    getItem(key) {
        return Object.prototype.hasOwnProperty.call(localStore, key) ? localStore[key] : null;
    },
    setItem(key, value) {
        localStore[key] = String(value);
    },
    removeItem(key) {
        delete localStore[key];
    },
    clear() {
        for (const key of Object.keys(localStore)) delete localStore[key];
    },
    key(index) {
        return Object.keys(localStore)[index] ?? null;
    },
    get length() {
        return Object.keys(localStore).length;
    },
};

/** Mutable extension settings bag used by getSettings() in unit tests. */
export const testExtensionSettings = {};

function saveSettingsDebounced() {}

globalThis.SillyTavern = {
    getContext() {
        return {
            extensionSettings: testExtensionSettings,
            chatId: 'vitest-chat',
            saveSettingsDebounced,
        };
    },
};

globalThis.saveSettingsDebounced = saveSettingsDebounced;
