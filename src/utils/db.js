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

    const normalized = games.map(g => {
        const obj = (g && typeof g === 'object') ? { ...g } : {};
        
        // Unify ID: Ensure both id and publicId exist and match
        if (!obj.id && obj.publicId) {
            obj.id = obj.publicId;
            changed = true;
        } else if (obj.id && !obj.publicId) {
            obj.publicId = obj.id;
            changed = true;
        } else if (!obj.id && !obj.publicId) {
            obj.id = obj.publicId = makePublicId();
            changed = true;
        }

        if (obj.hashId && typeof obj.hashId === 'string') {
            const lower = obj.hashId.toLowerCase();
            if (obj.hashId !== lower) {
                obj.hashId = lower;
                changed = true;
            }
        }

        // version can be null per user request
        if (obj.version === undefined) {
            obj.version = null;
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
            games = [];
        }
    }

    const { games: normalized, changed: normChanged } = normalizeGames(games);
    let changed = normChanged;

    // BACKFILL: If fileKey is missing but hashId exists, get it from the map once.
    // This allows us eventually kill the map file.
    for (const g of normalized) {
        if (!g.fileKey && g.hashId) {
            try {
                const { findKeyByHash } = await import('./md5-map.js');
                const key = await findKeyByHash(g.hashId);
                if (key) {
                    g.fileKey = key;
                    changed = true;
                }
            } catch (e) {}
        }
    }

    if (changed) {
        await writeDB(normalized);
    }
    return normalized;
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

// === Bucket File List Cache (10m) ===
let bucketFileCache = null;
let lastBucketListFetch = 0;
const BUCKET_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — only re-read on deploy restart

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
        
        if (persistent && Array.isArray(persistent.files)) {
            bucketFileCache = persistent.files;
            lastBucketListFetch = persistent.timestamp || now;
            return bucketFileCache;
        }
    } catch (e) {
        console.error('[CACHE] Error reading persistent cache:', e.message);
    }

    // 3. Last resort: internal state or empty
    return bucketFileCache || [];
}

/**
 * Checks if a file exists in the bucket without hitting the network.
 */
export async function checkFileInCache(key) {
    const files = await getBucketFileCache();
    return files.includes(key);
}

/**
 * Performs a REAL B2 bucket listing to rebuild the game_cache.json.
 * Use sparingly as it incurs Class C costs.
 */
export async function rebuildBucketCache() {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const { writeJsonToB2 } = await import('./s3-helpers.js');
    
    console.log('[CACHE] Rebuilding cache from real bucket list...');
    
    let allFiles = [];
    let continuationToken = null;
    
    try {
        do {
            const command = new ListObjectsV2Command({
                Bucket: config.B2.BUCKET_NAME,
                ContinuationToken: continuationToken
            });
            const response = await s3Client.send(command);
            
            if (response.Contents) {
                const keys = response.Contents.map(c => c.Key);
                allFiles.push(...keys);
            }
            
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        const now = Date.now();
        bucketFileCache = allFiles;
        lastBucketListFetch = now;

        await writeJsonToB2(config.B2.GAME_CACHE_KEY, {
            timestamp: now,
            files: allFiles
        });

        console.log(`[CACHE] Rebuild complete: ${allFiles.length} objects found`);
        return allFiles;
    } catch (err) {
        console.error('[CACHE] Rebuild failed:', err);
        throw err;
    }
}

/**
 * No-op version of refreshBucketFileCache to satisfy imports without costs.
 */
export async function refreshBucketFileCache() {
    return getBucketFileCache();
}

/**
 * Manually adds a single file to the cache and persists it to B2.
 */
export async function addFileToCache(key) {
    if (!key) return;
    try {
        const { writeJsonToB2 } = await import('./s3-helpers.js');
        const files = await getBucketFileCache();
        
        if (!files.includes(key)) {
            files.push(key);
            const now = Date.now();
            bucketFileCache = files;
            lastBucketListFetch = now;
            
            await writeJsonToB2(config.B2.GAME_CACHE_KEY, {
                timestamp: now,
                files: files
            });
            console.log(`[CACHE] Incrementally added ${key} to cache`);
        }
    } catch (err) {
        console.error('[CACHE] Incremental update failed:', err.message);
    }
}

/**
 * Parses a Quest game filename to extract Title and Version.
 * Rule: Find first lowercase 'v' followed by a digit. 
 * Everything before is Title. Everything after is Version until -VRP or .zip.
 */
export function parseQuestFilename(filename) {
    const base = String(filename || '').split('/').pop().replace(/\.zip$/i, '');
    
    // Find the first lowercase 'v' followed by a digit
    const match = base.match(/v(\d.*)/);
    
    if (match) {
        const vIndex = match.index;
        const afterV = match[0];
        
        const title = base.slice(0, vIndex).trim().replace(/[._-]$/, '').trim();
        
        // Version chunk: from 'v' until '-VRP' or ' - VRP'
        let version = afterV.split(/\s-\sVRP|-VRP/i)[0].trim();
        
        return { title, version };
    }
    
    // Fallback: title is everything, version is null per user preference
    return { title: base, version: null };
}

/**
 * Compares game_cache.json vs database.json and auto-registers missing games.
 * This runs in the background to save Class C costs (as it only reads memory cache).
 */
export async function autoAddGamesFromCache() {
    console.log('[AUTO-ADD] Starting daily sync...');
    const files = await getBucketFileCache();
    const db = await readDB();
    
    const zipFiles = files.filter(f => f.toLowerCase().endsWith('.zip'));
    const registeredKeys = new Set(db.map(g => g.fileKey || g.title + '.zip'));
    
    let addedCount = 0;
    const { hashId, readJsonFromB2 } = await import('./s3-helpers.js');
    
    for (const key of zipFiles) {
        const fallbackKey = key.toLowerCase().endsWith('.zip') ? key : key + '.zip';
        if (registeredKeys.has(key) || registeredKeys.has(fallbackKey)) continue;
        
        // New game found!
        const { title, version } = parseQuestFilename(key);
        const fileName = key.split('/').pop();
        
        const newGame = {
            id: makePublicId(),
            publicId: makePublicId(),
            title,
            version,
            fileKey: key,
            hashId: hashId(fileName.replace(/\.zip$/i, '')),
            description: '',
            thumbnailUrl: '',
            downloads: 0,
            lastUpdated: new Date().toISOString()
        };
        
        // Lookup Thumbnail: check cache for .meta/thumbnails/PACKAGE.jpg
        // We'd need the package name for this... for now we skip or guess if possible.
        // The user suggested using the VRP-GameList.txt for package mapping if we had it.
        
        // Lookup Notes: .meta/notes/FILENAME.txt
        const notesKey = `.meta/notes/${fileName.replace(/\.zip$/i, '.txt')}`;
        if (files.includes(notesKey)) {
            try {
                // Class B read (GetObject) - acceptable for auto-sync
                const notes = await readJsonFromB2(notesKey, null);
                if (notes && typeof notes === 'string') {
                    newGame.description = notes;
                } else if (notes && notes.description) {
                    newGame.description = notes.description;
                }
            } catch (e) {}
        }
        
        db.push(newGame);
        addedCount++;
    }
    
    if (addedCount > 0) {
        await writeDB(db);
        console.log(`[AUTO-ADD] Successfully registered ${addedCount} new games.`);
    } else {
        console.log('[AUTO-ADD] No new games found.');
    }
}

export function initAutoAddJob() {
    // Run on boot (with 10s delay to allow system to settle)
    setTimeout(() => {
        autoAddGamesFromCache().catch(e => console.error('[AUTO-ADD] Job failed:', e));
    }, 10000);
    
    // Run every 24 hours
    setInterval(() => {
        autoAddGamesFromCache().catch(e => console.error('[AUTO-ADD] Job failed:', e));
    }, 24 * 60 * 60 * 1000);
}
