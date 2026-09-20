import { logger } from '../utils/logger';

interface PerformanceSnapshot {
    timestamp: number;
    memoryUsageMB: number;
    uptimeSeconds: number;
    tickRate: number;
    activeModules: number;
    queueLength: number;
}

/**
 * PerformanceMonitor — tracks memory usage, tick rate, and uptime.
 * Emits warnings when thresholds are exceeded.
 * Periodically logs performance stats.
 */
export class PerformanceMonitor {
    private interval: NodeJS.Timeout | null = null;
    private startTime: number = Date.now();
    private tickCount: number = 0;
    private lastTickTime: number = Date.now();
    private history: PerformanceSnapshot[] = [];
    private maxHistorySize = 60; // Keep last 60 snapshots (10 min at 10s interval)

    // Thresholds
    private memoryWarnMB = 512;
    private memoryKillMB = 1024;
    private onThresholdExceeded: (() => void) | null = null;

    constructor(opts?: {
        memoryWarnMB?: number;
        memoryKillMB?: number;
        onThresholdExceeded?: () => void;
    }) {
        if (opts?.memoryWarnMB) this.memoryWarnMB = opts.memoryWarnMB;
        if (opts?.memoryKillMB) this.memoryKillMB = opts.memoryKillMB;
        if (opts?.onThresholdExceeded) this.onThresholdExceeded = opts.onThresholdExceeded;
    }

    /**
     * Start monitoring (snapshot every 10s).
     */
    start(intervalMs: number = 10000): void {
        this.startTime = Date.now();
        this.interval = setInterval(() => this.snapshot(), intervalMs);
        logger.info('PerfMonitor', `Started (snapshot every ${intervalMs / 1000}s, warn at ${this.memoryWarnMB}MB)`);
    }

    /**
     * Stop monitoring.
     */
    stop(): void {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    /**
     * Record a tick (call from the main game loop).
     */
    recordTick(): void {
        this.tickCount++;
        this.lastTickTime = Date.now();
    }

    /**
     * Get current stats.
     */
    getStats(): PerformanceSnapshot {
        const mem = process.memoryUsage();
        return {
            timestamp: Date.now(),
            memoryUsageMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
            uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
            tickRate: this.calculateTickRate(),
            activeModules: 0, // Set externally
            queueLength: 0,   // Set externally
        };
    }

    /**
     * Get a human-readable status string.
     */
    getStatusString(): string {
        const stats = this.getStats();
        const uptime = this.formatUptime(stats.uptimeSeconds);
        return `Memory: ${stats.memoryUsageMB}MB | Uptime: ${uptime} | Ticks: ${this.tickCount}`;
    }

    /**
     * Force garbage collection if available (requires --expose-gc flag).
     */
    forceGC(): boolean {
        if (typeof global.gc === 'function') {
            global.gc();
            logger.info('PerfMonitor', 'Forced garbage collection');
            return true;
        }
        return false;
    }

    // ─── Internal ───────────────────────────────────────

    private snapshot(): void {
        const stats = this.getStats();

        // Store history
        this.history.push(stats);
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }

        // Check thresholds
        if (stats.memoryUsageMB > this.memoryKillMB) {
            logger.error('PerfMonitor', `🚨 CRITICAL: Memory at ${stats.memoryUsageMB}MB (kill threshold: ${this.memoryKillMB}MB)`);
            this.forceGC();
            if (this.onThresholdExceeded) this.onThresholdExceeded();
        } else if (stats.memoryUsageMB > this.memoryWarnMB) {
            logger.warn('PerfMonitor', `⚠ Memory at ${stats.memoryUsageMB}MB (warn threshold: ${this.memoryWarnMB}MB)`);
            this.forceGC();
        }

        // Periodic log (every 6th snapshot = ~1 min)
        if (this.history.length % 6 === 0) {
            logger.info('PerfMonitor', this.getStatusString());
        }
    }

    private calculateTickRate(): number {
        // Ticks in the last 10 seconds
        const recent = this.history.slice(-2);
        if (recent.length < 2) return 0;
        const dt = (recent[1].timestamp - recent[0].timestamp) / 1000;
        return dt > 0 ? Math.round(this.tickCount / dt) : 0;
    }

    private formatUptime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}h ${m}m`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }
}
