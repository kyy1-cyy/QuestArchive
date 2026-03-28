import fs from 'fs/promises';
import crypto from 'crypto';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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

    // Track original order via publicId (if they exist)
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

    // Natural sort: Numbers first, then letters, accurately handling multi-digit numbers
    normalized.sort((a, b) => {
        const titleA = String(a.title || '').toLowerCase();
        const titleB = String(b.title || '').toLowerCase();
        return titleA.localeCompare(titleB, undefined, { numeric: true, sensitivity: 'base' });
    });

    // Check if sorting actually moved things
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

async function readDBFromR2() {
    try {
        const command = new GetObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: config.R2.DB_KEY
        });
        const res = await s3Client.send(command);
        if (!res.Body) return [];
        const str = await streamToString(res.Body);
        return str ? JSON.parse(str) : [];
    } catch (err) {
        if (err.name === 'NoSuchKey') {
            const legacyKey = config.R2.LEGACY_DB_KEY;
            if (legacyKey && legacyKey !== config.R2.DB_KEY) {
                try {
                    const legacyRes = await s3Client.send(new GetObjectCommand({
                        Bucket: config.R2.BUCKET_NAME,
                        Key: legacyKey
                    }));
                    if (!legacyRes.Body) return [];
                    const legacyStr = await streamToString(legacyRes.Body);
                    const data = legacyStr ? JSON.parse(legacyStr) : [];
                    await writeDBToR2(data);
                    await s3Client.send(new DeleteObjectCommand({
                        Bucket: config.R2.BUCKET_NAME,
                        Key: legacyKey
                    }));
                    return data;
                } catch (legacyErr) {
                    if (legacyErr.name === 'NoSuchKey') return [];
                    console.error('Error reading legacy DB from R2:', legacyErr);
                    return [];
                }
            }
            return [];
        }
        console.error('Error reading DB from R2:', err);
        return [];
    }
}

async function writeDBToR2(data) {
    try {
        await s3Client.send(new PutObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: config.R2.DB_KEY,
            Body: JSON.stringify(data, null, 2),
            ContentType: 'application/json'
        }));
    } catch (err) {
        console.error('Error writing DB to R2:', err);
    }
}

export async function readDB() {
    let games;
    if (config.R2.DB_KEY) {
        games = await readDBFromR2();
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
    if (config.R2.DB_KEY) return writeDBToR2(data);
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
