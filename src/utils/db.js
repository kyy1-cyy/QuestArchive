import fs from 'fs/promises';
import crypto from 'crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { s3Client } from './s3.js';

export function makePublicId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
}

export function normalizeGames(games) {
    if (!Array.isArray(games)) return { games: [], changed: false };
    let changed = false;

    const originalIds = games.map(g => String(g.publicId || '')).join('|');

    const normalized = games.map(g => {
        const obj = (g && typeof g === 'object') ? { ...g } : {};
        if (!obj.publicId) {
            obj.publicId = makePublicId();
            changed = true;
        }
        if (obj.hashId && typeof obj.hashId === 'string') {
            const lower = obj.hashId.toLowerCase();
            if (obj.hashId !== lower) {
                obj.hashId = lower;
                changed = true;
            }
        }
        if (!obj.version) {
            obj.version = '1.0';
            changed = true;
        }
        if (!obj.lastUpdated) {
            obj.lastUpdated = new Date().toISOString();
            changed = true;
        }
        return obj;
    });

    normalized.sort((a, b) => {
        const titleA = String(a.title || '').toLowerCase();
        const titleB = String(b.title || '').toLowerCase();

        const aStartsUnderscore = titleA.startsWith('_');
        const bStartsUnderscore = titleB.startsWith('_');

        if (aStartsUnderscore && !bStartsUnderscore) return -1;
        if (!aStartsUnderscore && bStartsUnderscore) return 1;

        return titleA.localeCompare(titleB, undefined, { numeric: true, sensitivity: 'base' });
    });

    const currentIds = normalized.map(g => g.publicId).join('|');
    if (originalIds !== currentIds) {
        changed = true;
    }

    return { games: normalized, changed };
}

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

let cachedDB = null;
let lastDBFetch = 0;
const DB_CACHE_TTL = 10 * 60 * 1000; // 10 minutes memory cache for database.json

async function readDBFromB2() {
    const now = Date.now();
    if (cachedDB && (now - lastDBFetch < DB_CACHE_TTL)) {
        return cachedDB;
    }

    try {
        const command = new GetObjectCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: config.B2.DB_KEY
        });
        const res = await s3Client.send(command);
        if (!res.Body) return [];
        const str = await streamToString(res.Body);
        const data = str ? JSON.parse(str) : [];
        cachedDB = data;
        lastDBFetch = now;
        return data;
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return [];
        }
        console.error('Error reading DB from B2:', err);
        return cachedDB || [];
    }
}

async function writeDBToB2(data) {
    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: config.B2.DB_KEY,
            Body: JSON.stringify(data, null, 2),
            ContentType: 'application/json'
        }));
        // Update local cache immediately
        cachedDB = data;
        lastDBFetch = Date.now();
    } catch (err) {
        console.error('Error writing DB to B2:', err);
    }
}

export async function readDB() {
    let games;
    if (config.B2.DB_KEY) {
        games = await readDBFromB2();
    } else {
        try {
            const data = await fs.readFile(config.PATHS.DB, 'utf-8');
            games = data ? JSON.parse(data) : [];
        } catch (err) {
            if (err.code === 'ENOENT') {
                await fs.mkdir(config.PATHS.DATA, { recursive: true }).catch(() => {});
                await fs.writeFile(config.PATHS.DB, '[]');
                games = [];
            } else {
                console.error('Error reading DB:', err);
                games = [];
            }
        }
    }

    const normalized = normalizeGames(games);
    if (normalized.changed) {
        await writeDB(normalized.games);
    }
    return normalized.games;
}

export async function writeDB(data) {
    if (config.B2.DB_KEY) return writeDBToB2(data);
    await fs.writeFile(config.PATHS.DB, JSON.stringify(data, null, 2));
}

export async function incrementDownloadCount(id) {
    const games = await readDB();
    const game = games.find(g => g.id === id || g.publicId === id);
    if (game) {
        game.downloads = (game.downloads || 0) + 1;
        await writeDB(games);
    }
}

// === Bucket File List Cache (24h) ===
let bucketFileCache = null;
let lastBucketListFetch = 0;
const BUCKET_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function getBucketFileCache() {
    const now = Date.now();
    
    // 1. Try memory cache (Fastest)
    if (bucketFileCache && (now - lastBucketListFetch < BUCKET_CACHE_TTL)) {
        return bucketFileCache;
    }

    // 2. Try persistent file cache on B2 (Fast)
    try {
        const { readJsonFromB2 } = await import('./s3-helpers.js');
        const persistent = await readJsonFromB2(config.B2.GAME_CACHE_KEY, null);
        
        if (persistent && persistent.timestamp) {
            bucketFileCache = persistent.files || [];
            lastBucketListFetch = persistent.timestamp;
            return bucketFileCache;
        }
    } catch (e) {
        console.error('[CACHE] Error reading persistent cache:', e.message);
    }

    // 3. Fallback: return empty but don't block. 
    // Listing handles itself via background setInterval in server.js or manual refresh.
    return bucketFileCache || [];
}

export async function refreshBucketFileCache() {
    console.log('[B2] Active bucket listing (Class C) starting...');
    const { listAllObjects, writeJsonToB2 } = await import('./s3-helpers.js');
    try {
        const allObjects = await listAllObjects('');
        const files = allObjects.map(obj => obj.Key).filter(Boolean);
        
        const now = Date.now();
        bucketFileCache = files;
        lastBucketListFetch = now;

        await writeJsonToB2(config.B2.GAME_CACHE_KEY, {
            timestamp: now,
            files: files
        });

        console.log(`[B2] Cache updated with ${files.length} files. Saved to ${config.B2.GAME_CACHE_KEY}`);
        return files;
    } catch (err) {
        console.error('[B2] FAILED listing bucket:', err.message);
        return bucketFileCache || [];
    }
}
