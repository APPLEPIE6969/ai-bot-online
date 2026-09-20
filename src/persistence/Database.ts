import * as path from 'path';
import { AtomicWriter } from './AtomicWriter';
import { BotConfig, PersistedState, StashEntry } from '../types/interfaces';
import { Mode } from '../types/enums';
import { logger } from '../utils/logger';

const DATA_DIR = path.resolve(__dirname, '../../data');
const CONFIG_DIR = path.resolve(__dirname, '../../config');

const STATE_FILE = path.join(DATA_DIR, 'state.db.json');
const STASH_FILE = path.join(DATA_DIR, 'stash.db.json');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_STATE: PersistedState = {
    mode: Mode.FULL_AUTO,
    activeTaskId: null,
    position: null,
    stashes: [],
    lastSaved: 0,
};

const DEFAULT_CONFIG: BotConfig = {
    mode: Mode.FULL_AUTO,
    serverHost: 'peak.progamer.me',
    serverPort: 25565,
    botUsername: 'AIBot',
    confirmationTimeout: 30,
    autoBuildFarms: true,
    autoStash: true,
    maxTaskRetries: 3,
    autoReconnect: true,
    reconnectDelayMs: 5000,
    maxReconnectDelayMs: 60000,
    apiKeys: { google: '', groq: '' },
    aiModels: ['gemini-2.0-flash', 'llama-3.3-70b-versatile'],
};

export class Database {
    private state: PersistedState;
    private config: BotConfig;

    constructor() {
        this.state = AtomicWriter.read<PersistedState>(STATE_FILE, DEFAULT_STATE);
        this.config = AtomicWriter.read<BotConfig>(CONFIG_FILE, DEFAULT_CONFIG);
        logger.info('Database', 'Loaded persisted state and config');
    }

    // ─── Config ─────────────────────────────────────────
    getConfig(): BotConfig {
        return { ...this.config };
    }

    reloadConfig(): BotConfig {
        this.config = AtomicWriter.read<BotConfig>(CONFIG_FILE, DEFAULT_CONFIG);
        logger.info('Database', 'Config hot-reloaded');
        return this.config;
    }

    // ─── State ──────────────────────────────────────────
    getState(): PersistedState {
        return { ...this.state };
    }

    saveState(updates: Partial<PersistedState>): void {
        this.state = { ...this.state, ...updates, lastSaved: Date.now() };
        AtomicWriter.write(STATE_FILE, this.state);
        logger.debug('Database', 'State saved');
    }

    // ─── Stash ──────────────────────────────────────────
    getStashes(): StashEntry[] {
        return [...this.state.stashes];
    }

    addStash(stash: StashEntry): void {
        this.state.stashes.push(stash);
        this.saveState({ stashes: this.state.stashes });
        logger.info('Database', `Stash added: ${stash.id} at (${stash.x}, ${stash.y}, ${stash.z})`);
    }

    updateStash(stashId: string, updates: Partial<StashEntry>): void {
        const idx = this.state.stashes.findIndex(s => s.id === stashId);
        if (idx === -1) {
            logger.warn('Database', `Stash ${stashId} not found for update`);
            return;
        }
        this.state.stashes[idx] = { ...this.state.stashes[idx], ...updates };
        this.saveState({ stashes: this.state.stashes });
    }

    removeStash(stashId: string): void {
        this.state.stashes = this.state.stashes.filter(s => s.id !== stashId);
        this.saveState({ stashes: this.state.stashes });
        logger.info('Database', `Stash removed: ${stashId}`);
    }
}
