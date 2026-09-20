import * as path from 'path';
import { AtomicWriter } from '../persistence/AtomicWriter';
import { EventBus } from '../core/EventBus';
import { logger } from '../utils/logger';

const DATA_DIR = path.resolve(__dirname, '../../data');
const RECOVERY_FILE = path.join(DATA_DIR, 'recovery.db.json');

/**
 * Recovery state saved on crash/shutdown
 */
interface RecoveryState {
    /** What the bot was doing when interrupted */
    lastTaskName: string | null;
    /** Bot position at time of save */
    position: { x: number; y: number; z: number } | null;
    /** Timestamp of the save */
    savedAt: number;
    /** Reason for the save (crash, shutdown, disconnect) */
    reason: string;
    /** How many consecutive crashes have occurred */
    consecutiveCrashes: number;
    /** Any pending action that should be retried */
    pendingAction: string | null;
}

const DEFAULT_RECOVERY: RecoveryState = {
    lastTaskName: null,
    position: null,
    savedAt: 0,
    reason: '',
    consecutiveCrashes: 0,
    pendingAction: null,
};

/**
 * RecoveryManager — saves state pre-crash and resumes post-reconnect.
 * - Saves task & position on crash/disconnect
 * - Detects consecutive crash loops and backs off
 * - Provides resume hints to TaskEngine on reconnect
 */
export class RecoveryManager {
    private state: RecoveryState;
    private crashThreshold = 5; // Stop auto-resume after 5 consecutive crashes

    constructor(private eventBus: EventBus) {
        this.state = AtomicWriter.read<RecoveryState>(RECOVERY_FILE, DEFAULT_RECOVERY);

        // Check for crash loop
        if (this.state.consecutiveCrashes >= this.crashThreshold) {
            logger.warn('Recovery', `⚠ ${this.state.consecutiveCrashes} consecutive crashes detected! Auto-resume disabled.`);
        }
    }

    /**
     * Save state before a potential crash/shutdown.
     */
    saveState(opts: {
        taskName?: string | null;
        position?: { x: number; y: number; z: number } | null;
        reason: string;
        pendingAction?: string | null;
    }): void {
        this.state = {
            lastTaskName: opts.taskName ?? this.state.lastTaskName,
            position: opts.position ?? this.state.position,
            savedAt: Date.now(),
            reason: opts.reason,
            consecutiveCrashes: opts.reason === 'crash'
                ? this.state.consecutiveCrashes + 1
                : 0, // Reset on clean shutdown
            pendingAction: opts.pendingAction ?? null,
        };

        AtomicWriter.write(RECOVERY_FILE, this.state);
        logger.info('Recovery', `State saved: ${opts.reason} (crashes: ${this.state.consecutiveCrashes})`);
    }

    /**
     * Mark a clean startup — resets crash counter.
     */
    markCleanStart(): void {
        if (this.state.consecutiveCrashes > 0) {
            logger.info('Recovery', `Clean start — resetting crash counter (was ${this.state.consecutiveCrashes})`);
        }
        this.state.consecutiveCrashes = 0;
        AtomicWriter.write(RECOVERY_FILE, this.state);
    }

    /**
     * Check if we should auto-resume tasks after reconnect.
     */
    shouldAutoResume(): boolean {
        return this.state.consecutiveCrashes < this.crashThreshold;
    }

    /**
     * Get what the bot was doing before the interruption.
     */
    getLastTask(): string | null {
        return this.state.lastTaskName;
    }

    /**
     * Get any pending action to retry.
     */
    getPendingAction(): string | null {
        return this.state.pendingAction;
    }

    /**
     * Get the last known position.
     */
    getLastPosition(): { x: number; y: number; z: number } | null {
        return this.state.position;
    }

    /**
     * Get time since last save.
     */
    getTimeSinceLastSave(): number {
        return this.state.savedAt > 0 ? Date.now() - this.state.savedAt : Infinity;
    }

    /**
     * Get recovery summary for status display.
     */
    getSummary(): string {
        if (this.state.savedAt === 0) return 'No recovery data.';
        const ago = Math.round((Date.now() - this.state.savedAt) / 1000);
        return `Last save: ${ago}s ago | Reason: ${this.state.reason} | Crashes: ${this.state.consecutiveCrashes} | Task: ${this.state.lastTaskName || 'none'}`;
    }
}
