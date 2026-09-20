import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const DATA_DIR = path.resolve(__dirname, '../../data');
const BACKUP_DIR = path.resolve(__dirname, '../../data/backups');

/**
 * BackupManager — periodic snapshots of all .db.json files.
 * - Runs on a configurable interval (default: 5 minutes)
 * - Keeps the most recent N backups (default: 10)
 * - Validates JSON integrity on load
 */
export class BackupManager {
    private interval: NodeJS.Timeout | null = null;
    private maxBackups: number;
    private intervalMs: number;

    constructor(intervalMs: number = 5 * 60 * 1000, maxBackups: number = 10) {
        this.intervalMs = intervalMs;
        this.maxBackups = maxBackups;

        // Ensure backup directory exists
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }
    }

    /**
     * Start periodic backups.
     */
    start(): void {
        this.interval = setInterval(() => this.createBackup(), this.intervalMs);
        logger.info('BackupManager', `Started (every ${this.intervalMs / 1000}s, keep ${this.maxBackups})`);
    }

    /**
     * Stop periodic backups.
     */
    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    /**
     * Create a timestamped backup of all data files.
     */
    createBackup(): void {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `backup_${timestamp}`;
        const backupPath = path.join(BACKUP_DIR, backupName);

        try {
            fs.mkdirSync(backupPath, { recursive: true });

            // Copy all .db.json files
            const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.db.json'));
            let copied = 0;

            for (const file of files) {
                const src = path.join(DATA_DIR, file);
                const dst = path.join(backupPath, file);

                // Validate JSON before backing up
                try {
                    const raw = fs.readFileSync(src, 'utf-8');
                    JSON.parse(raw); // Validates
                    fs.copyFileSync(src, dst);
                    copied++;
                } catch (e) {
                    logger.warn('BackupManager', `Skipping corrupt file: ${file}`);
                }
            }

            logger.info('BackupManager', `Backup created: ${backupName} (${copied} files)`);
            this.pruneOldBackups();
        } catch (e) {
            logger.error('BackupManager', `Backup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Restore from the most recent valid backup.
     */
    restoreLatest(): boolean {
        const backups = this.listBackups();
        if (backups.length === 0) {
            logger.warn('BackupManager', 'No backups available to restore');
            return false;
        }

        // Try latest first, then older ones
        for (const backup of backups) {
            const backupPath = path.join(BACKUP_DIR, backup);
            try {
                const files = fs.readdirSync(backupPath).filter(f => f.endsWith('.db.json'));
                let valid = true;

                // Validate all files first
                for (const file of files) {
                    try {
                        const raw = fs.readFileSync(path.join(backupPath, file), 'utf-8');
                        JSON.parse(raw);
                    } catch {
                        valid = false;
                        break;
                    }
                }

                if (!valid) continue;

                // Restore
                for (const file of files) {
                    fs.copyFileSync(path.join(backupPath, file), path.join(DATA_DIR, file));
                }

                logger.info('BackupManager', `Restored from backup: ${backup} (${files.length} files)`);
                return true;
            } catch (e) {
                logger.warn('BackupManager', `Backup ${backup} corrupted, trying older...`);
            }
        }

        logger.error('BackupManager', 'All backups corrupted!');
        return false;
    }

    /**
     * List available backups (newest first).
     */
    listBackups(): string[] {
        if (!fs.existsSync(BACKUP_DIR)) return [];
        return fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('backup_'))
            .sort()
            .reverse();
    }

    // ─── Internal ───────────────────────────────────────

    private pruneOldBackups(): void {
        const backups = this.listBackups();
        if (backups.length <= this.maxBackups) return;

        const toDelete = backups.slice(this.maxBackups);
        for (const backup of toDelete) {
            const dir = path.join(BACKUP_DIR, backup);
            try {
                fs.rmSync(dir, { recursive: true });
                logger.debug('BackupManager', `Pruned old backup: ${backup}`);
            } catch (e) {
                logger.warn('BackupManager', `Failed to prune ${backup}`);
            }
        }
    }
}
