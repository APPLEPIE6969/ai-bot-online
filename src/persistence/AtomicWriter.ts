import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Atomic JSON file writer. Writes to .tmp, then renames to target.
 * Creates backup of existing file before overwrite.
 */
export class AtomicWriter {
    /**
     * Atomically write data to a JSON file.
     * 1. Write to .tmp file
     * 2. Backup existing file to .bak
     * 3. Rename .tmp to target
     */
    static write(filePath: string, data: unknown): void {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const tmpPath = filePath + '.tmp';
        const bakPath = filePath + '.bak';
        const json = JSON.stringify(data, null, 2);

        // Step 1: Write to temp file
        fs.writeFileSync(tmpPath, json, 'utf-8');

        // Step 2: Backup existing file
        if (fs.existsSync(filePath)) {
            try {
                fs.copyFileSync(filePath, bakPath);
            } catch (e) {
                logger.warn('AtomicWriter', `Failed to create backup: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // Step 3: Rename tmp → target (atomic on most filesystems)
        fs.renameSync(tmpPath, filePath);
    }

    /**
     * Read and parse a JSON file, falling back to .bak if corrupt.
     */
    static read<T>(filePath: string, fallback: T): T {
        // Try main file
        try {
            if (fs.existsSync(filePath)) {
                const raw = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(raw) as T;
            }
        } catch (e) {
            logger.warn('AtomicWriter', `Main file corrupt (${filePath}), trying backup...`);
        }

        // Try backup
        const bakPath = filePath + '.bak';
        try {
            if (fs.existsSync(bakPath)) {
                const raw = fs.readFileSync(bakPath, 'utf-8');
                logger.info('AtomicWriter', `Recovered from backup: ${bakPath}`);
                return JSON.parse(raw) as T;
            }
        } catch (e) {
            logger.error('AtomicWriter', `Backup also corrupt: ${bakPath}`);
        }

        logger.info('AtomicWriter', `Using fallback for ${filePath}`);
        return fallback;
    }
}
