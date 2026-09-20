import * as fs from 'fs';
import * as path from 'path';
import { EventBus } from '../core/EventBus';
import { BotConfig } from '../types/interfaces';
import { AtomicWriter } from '../persistence/AtomicWriter';
import { logger } from '../utils/logger';

const CONFIG_FILE = path.resolve(__dirname, '../../config/config.json');

/**
 * ConfigHotReload — watches config.json for changes and emits events.
 * Polls every N seconds (file watchers are unreliable on Windows).
 */
export class ConfigHotReload {
    private interval: NodeJS.Timeout | null = null;
    private lastModified: number = 0;
    private lastHash: string = '';

    constructor(
        private eventBus: EventBus,
        private pollIntervalMs: number = 10000
    ) {
        this.updateLastModified();
    }

    /**
     * Start polling for config changes.
     */
    start(): void {
        this.interval = setInterval(() => this.check(), this.pollIntervalMs);
        logger.info('HotReload', `Watching config (poll every ${this.pollIntervalMs / 1000}s)`);
    }

    /**
     * Stop polling.
     */
    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    /**
     * Force a reload check now.
     */
    forceCheck(): void {
        this.check();
    }

    // ─── Internal ───────────────────────────────────────

    private check(): void {
        try {
            const stat = fs.statSync(CONFIG_FILE);
            const mtime = stat.mtimeMs;

            if (mtime <= this.lastModified) return; // No change

            // File changed — validate and reload
            const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
            const hash = this.simpleHash(raw);

            if (hash === this.lastHash) return; // Same content (e.g. touch)

            // Validate JSON
            let newConfig: BotConfig;
            try {
                newConfig = JSON.parse(raw) as BotConfig;
            } catch (e) {
                logger.warn('HotReload', 'Config file has invalid JSON — ignoring change');
                return;
            }

            // Validate required fields
            if (!newConfig.serverHost || !newConfig.botUsername) {
                logger.warn('HotReload', 'Config missing required fields — ignoring');
                return;
            }

            this.lastModified = mtime;
            this.lastHash = hash;

            logger.info('HotReload', '🔄 Config reloaded!');
            this.eventBus.emit('config:reload', newConfig);
        } catch (e) {
            // Config file may be temporarily unavailable during write
            logger.debug('HotReload', `Check failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private updateLastModified(): void {
        try {
            const stat = fs.statSync(CONFIG_FILE);
            this.lastModified = stat.mtimeMs;
            const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
            this.lastHash = this.simpleHash(raw);
        } catch {
            this.lastModified = 0;
            this.lastHash = '';
        }
    }

    private simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return hash.toString(36);
    }
}
