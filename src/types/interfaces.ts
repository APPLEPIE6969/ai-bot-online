import { Bot } from 'mineflayer';
import { TaskPriority, TaskCategory, Mode } from './enums';

// ─── Task ───────────────────────────────────────────────────────
export interface Task {
    id: string;
    name: string;
    priority: TaskPriority;
    category: TaskCategory;
    requiresConfirmation: boolean;
    retries: number;
    maxRetries: number;
    timeoutMs: number;
    execute(): Promise<void>;
    cancel(): Promise<void>;
    onTimeout?(): Promise<void>;
}

// ─── Module ─────────────────────────────────────────────────────
// Note: eventBus is typed as 'any' here to avoid circular dependency
// (types/ should not import from core/). Each module casts internally.
export interface Module {
    name: string;
    init(bot: Bot, eventBus: any): Promise<void>;
    cleanup(): Promise<void>;
}

// ─── Stash Entry ────────────────────────────────────────────────
export interface StashEntry {
    id: string;
    label: string;
    x: number;
    y: number;
    z: number;
    items: Array<{ name: string; count: number }>;
    createdAt: number;
    lastAccessed: number;
    verified: boolean;
}

// ─── Config ─────────────────────────────────────────────────────
export interface BotConfig {
    mode: Mode;
    serverHost: string;
    serverPort: number;
    botUsername: string;
    confirmationTimeout: number;
    autoBuildFarms: boolean;
    autoStash: boolean;
    maxTaskRetries: number;
    autoReconnect: boolean;
    reconnectDelayMs: number;
    maxReconnectDelayMs: number;
    apiKeys: {
        google: string;
        groq: string;
    };
    aiModels: string[];
}

// ─── Persisted State ────────────────────────────────────────────
export interface PersistedState {
    mode: Mode;
    activeTaskId: string | null;
    position: { x: number; y: number; z: number } | null;
    stashes: StashEntry[];
    lastSaved: number;
}

// ─── Event Payloads ─────────────────────────────────────────────
export interface BotEvents {
    'state:change': { from: string; to: string };
    'task:start': { taskId: string; name: string };
    'task:complete': { taskId: string; name: string; success: boolean };
    'task:cancel': { taskId: string; reason: string };
    'emergency:triggered': { type: string; detail: string };
    'emergency:resolved': { type: string };
    'stash:created': { stash: StashEntry };
    'stash:updated': { stash: StashEntry };
    'mode:change': { from: Mode; to: Mode };
    'chat:incoming': { username: string; message: string };
    'chat:outgoing': { message: string };
}
