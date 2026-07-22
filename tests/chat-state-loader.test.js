import { describe, expect, it } from 'vitest';
import { createChatStateLoader } from '../src/features/chat/chat-state-loader.js';

describe('chat state loader', () => {
    it('returns a callable loader function', () => {
        expect(typeof createChatStateLoader({})).toBe('function');
    });
});
