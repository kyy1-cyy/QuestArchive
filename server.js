import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getR2EndpointBase(rawEndpoint) {
    if (!rawEndpoint) return undefined;
    try {
        const u = new URL(rawEndpoint);
        return `${u.protocol}//${u.host}`;
    } catch {
        return rawEndpoint;
    }
}

function ensureUploadEnv(req, res) {
    const missing = [];
    if (!process.env.R2_ENDPOINT) missing.push('R2_ENDPOINT');
    if (!process.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
    if (!process.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
    if (!process.env.R2_BUCKET_NAME) missing.push('R2_BUCKET_NAME');

    if (missing.length) {
        res.status(500).json({
            error: `Server missing required env vars for upload: ${missing.join(', ')}`
        });
        return false;
    }
    return true;
}

const DONATIONS_BUCKET_NAME = process.env.DONATIONS_R2_BUCKET_NAME || 'quest-archive-donations';

function ensureDonationsEnv(req, res) {
    const missing = [];
    if (!process.env.R2_ENDPOINT) missing.push('R2_ENDPOINT');
    if (!process.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
    if (!process.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
    if (!DONATIONS_BUCKET_NAME) missing.push('DONATIONS_R2_BUCKET_NAME');

    if (missing.length) {
        res.status(500).json({
            error: `Server missing required env vars for donations upload: ${missing.join(', ')}`
        });
        return false;
    }
    return true;
}

function sanitizeFilename(name) {
    const base = String(name || '').replace(/[\\/]/g, '_').trim();
    return base.replace(/[^\w.\- ]+/g, '_').slice(0, 180) || 'upload.zip';
}

function makeDonationKey(filename) {
    const clean = sanitizeFilename(filename)
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .toLowerCase();
    return `donation/${clean}`;
}

function ensureGithubEnv(req, res) {
    const missing = [];
    if (!GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
    if (!GITHUB_OWNER) missing.push('GITHUB_OWNER');
    if (!GITHUB_REPO) missing.push('GITHUB_REPO');
    if (!GITHUB_BRANCH) missing.push('GITHUB_BRANCH');
    if (!GITHUB_IMAGES_PATH) missing.push('GITHUB_IMAGES_PATH');

    if (missing.length) {
        res.status(500).json({
            error: `Server missing required env vars for GitHub image upload: ${missing.join(', ')}`
        });
        return false;
    }
    return true;
}

function sanitizeImageBasename(title) {
    const base = String(title || '')
        .trim()
        .toLowerCase()
        .replace(/['"]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return base || 'image';
}

async function githubRequest(url, options) {
    const res = await fetch(url, {
        ...options,
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(options?.headers || {})
        }
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, json, text };
}

// Configure S3 Client for Cloudflare R2
const s3Client = new S3Client({
    region: 'auto',
    endpoint: getR2EndpointBase(process.env.R2_ENDPOINT),
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
    }
});

const DB_PATH = path.join(__dirname, 'data', 'database.txt');
const R2_DB_KEY = process.env.R2_DB_KEY || '';
const DONATIONS_PUBLIC_DOMAIN = process.env.DONATIONS_PUBLIC_DOMAIN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'kyy1-cyy';
const GITHUB_REPO = process.env.GITHUB_REPO || 'QuestArchive';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_IMAGES_PATH = process.env.GITHUB_IMAGES_PATH || 'data';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

function makePublicId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
}

function normalizeGames(games) {
    if (!Array.isArray(games)) return { games: [], changed: false };

    let changed = false;
    const normalized = games.map(g => {
        const obj = (g && typeof g === 'object') ? { ...g } : {};
        if (!obj.publicId) {
            obj.publicId = makePublicId();
            changed = true;
        }
        if (obj.hashId && typeof obj.hashId === 'string') {
            const lower = obj.hashId.toLowerCase();
            if (lower !== obj.hashId) {
                obj.hashId = lower;
                changed = true;
            }
        }
        return obj;
    });

    return { games: normalized, changed };
}

// Helper to read DB
async function readDB() {
    let games;
    if (R2_DB_KEY) {
        games = await readDBFromR2();
    } else {
        try {
            const data = await fs.readFile(DB_PATH, 'utf-8');
            games = data ? JSON.parse(data) : [];
        } catch (err) {
            if (err.code === 'ENOENT') {
                await fs.writeFile(DB_PATH, '[]');
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

// Helper to write DB
async function writeDB(data) {
    if (R2_DB_KEY) return writeDBToR2(data);
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

function requireAdmin(req, res) {
    const { password } = req.headers;
    if (password !== process.env.ADMIN_PASSWORD) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function readDBFromR2() {
    const bucket = process.env.R2_BUCKET_NAME || '';
    if (!bucket) return [];

    try {
        const command = new GetObjectCommand({
            Bucket: bucket,
            Key: R2_DB_KEY
        });
        const result = await s3Client.send(command);
        const bodyString = result.Body ? await streamToString(result.Body) : '[]';
        const parsed = JSON.parse(bodyString || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        if (status === 404) {
            await writeDBToR2([]);
            return [];
        }
        console.error('Error reading DB from R2:', err);
        return [];
    }
}

async function writeDBToR2(data) {
    const bucket = process.env.R2_BUCKET_NAME || '';
    if (!bucket) return;

    const body = JSON.stringify(data ?? [], null, 2);
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: R2_DB_KEY,
        Body: body,
        ContentType: 'application/json',
        CacheControl: 'no-store'
    });
    await s3Client.send(command);
}

// Routes
// Get all games
app.get('/api/games', async (req, res) => {
    const games = await readDB();
    const publicGames = games.map(g => ({
        id: g.publicId,
        title: g.title,
        version: g.version,
        description: g.description,
        thumbnailUrl: g.thumbnailUrl
    }));
    res.json(publicGames);
});

// Admin Route: Get all games
app.get('/api/database', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const games = await readDB();
    res.json(games);
});

// Admin Route: Add Game
app.post('/api/database', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    
    const { title, version, description, thumbnailUrl, hashId } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    if (hashId && !/^[a-f0-9]{32}$/i.test(String(hashId))) {
        return res.status(400).json({ error: 'hashId must be a 32-character hex MD5' });
    }

    // Under the hood we just assign a unique timestamp ID to keep the JSON valid
    const newGame = {
        id: Date.now().toString(),
        publicId: makePublicId(),
        title,
        hashId: hashId ? String(hashId).toLowerCase() : '',
        version: version || '1.0',
        description: description || '',
        thumbnailUrl: thumbnailUrl || 'https://via.placeholder.com/300x400?text=No+Image'
    };

    const games = await readDB();
    games.push(newGame);
    await writeDB(games);

    res.status(201).json(newGame);
});

// Admin Route: Bulk Delete Games
app.post('/api/database/bulk-delete', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    const { ids } = req.body;
    if (!Array.isArray(ids)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    let games = await readDB();
    games = games.filter(g => !ids.includes(g.id));
    await writeDB(games);

    res.json({ success: true });
});

// Admin Route: Delete Single Game (Fallback/Legacy)
app.delete('/api/admin/games/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;

    let games = await readDB();
    games = games.filter(g => g.id !== req.params.id);
    await writeDB(games);

    res.json({ success: true });
});

app.post('/api/uploads/init', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureUploadEnv(req, res)) return;

    const { filename, prefix, hashId } = req.body ?? {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip files are allowed' });
    }
    if (hashId && !/^[a-f0-9]{32}$/i.test(String(hashId))) {
        return res.status(400).json({ error: 'hashId must be a 32-character hex MD5' });
    }

    const cleanFilename = filename.replace(/[\\/]/g, '_').trim();
    const cleanPrefix = (typeof prefix === 'string' ? prefix : '').trim().replace(/^\//, '').replace(/\\/g, '/');
    if (cleanPrefix.includes('..')) {
        return res.status(400).json({ error: 'Invalid prefix' });
    }
    const finalName = hashId ? `${String(hashId).toLowerCase()}.zip` : cleanFilename;
    const key = cleanPrefix ? `${cleanPrefix.replace(/\/+$/, '')}/${finalName}` : finalName;

    try {
        const command = new CreateMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            ContentType: 'application/zip'
        });
        const result = await s3Client.send(command);
        res.json({ uploadId: result.UploadId, key });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to initialize upload: ${err.message}` : 'Failed to initialize upload'
        });
    }
});

app.post('/api/uploads/part-url', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureUploadEnv(req, res)) return;

    const { key, uploadId, partNumber } = req.body ?? {};
    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber are required' });
    }

    try {
        const command = new UploadPartCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: Number(partNumber)
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to sign part url: ${err.message}` : 'Failed to sign part url'
        });
    }
});

app.post('/api/uploads/complete', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureUploadEnv(req, res)) return;

    const { key, uploadId, parts } = req.body ?? {};
    if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: 'key, uploadId, parts are required' });
    }

    try {
        const command = new CompleteMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts
                    .map(p => ({ ETag: p.ETag, PartNumber: Number(p.PartNumber) }))
                    .filter(p => p.ETag && p.PartNumber)
                    .sort((a, b) => a.PartNumber - b.PartNumber)
            }
        });
        await s3Client.send(command);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to complete upload: ${err.message}` : 'Failed to complete upload'
        });
    }
});

app.post('/api/uploads/abort', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureUploadEnv(req, res)) return;

    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) {
        return res.status(400).json({ error: 'key and uploadId are required' });
    }

    try {
        const command = new AbortMultipartUploadCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key,
            UploadId: uploadId
        });
        await s3Client.send(command);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to abort upload: ${err.message}` : 'Failed to abort upload'
        });
    }
});

app.post('/api/donations/init', async (req, res) => {
    if (!ensureDonationsEnv(req, res)) return;

    const { filename } = req.body ?? {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip files are allowed' });
    }

    const key = makeDonationKey(filename);

    try {
        const command = new CreateMultipartUploadCommand({
            Bucket: DONATIONS_BUCKET_NAME,
            Key: key,
            ContentType: 'application/zip'
        });
        const result = await s3Client.send(command);
        res.json({ uploadId: result.UploadId, key });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to initialize upload: ${err.message}` : 'Failed to initialize upload'
        });
    }
});

app.post('/api/donations/part-url', async (req, res) => {
    if (!ensureDonationsEnv(req, res)) return;

    const { key, uploadId, partNumber } = req.body ?? {};
    if (!key || !uploadId || !partNumber) {
        return res.status(400).json({ error: 'key, uploadId, partNumber are required' });
    }
    if (!String(key).endsWith('.zip')) {
        return res.status(400).json({ error: 'Invalid key' });
    }

    try {
        const command = new UploadPartCommand({
            Bucket: DONATIONS_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            PartNumber: Number(partNumber)
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to sign part url: ${err.message}` : 'Failed to sign part url'
        });
    }
});

app.post('/api/donations/complete', async (req, res) => {
    if (!ensureDonationsEnv(req, res)) return;

    const { key, uploadId, parts } = req.body ?? {};
    if (!key || !uploadId || !Array.isArray(parts) || parts.length === 0) {
        return res.status(400).json({ error: 'key, uploadId, parts are required' });
    }
    if (!String(key).endsWith('.zip')) {
        try {
            await s3Client.send(new AbortMultipartUploadCommand({ Bucket: DONATIONS_BUCKET_NAME, Key: key, UploadId: uploadId }));
        } catch (_) {}
        return res.status(400).json({ error: 'Invalid key' });
    }

    try {
        const command = new CompleteMultipartUploadCommand({
            Bucket: DONATIONS_BUCKET_NAME,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
                Parts: parts
                    .map(p => ({ ETag: p.ETag, PartNumber: Number(p.PartNumber) }))
                    .filter(p => p.ETag && p.PartNumber)
                    .sort((a, b) => a.PartNumber - b.PartNumber)
            }
        });
        await s3Client.send(command);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to complete upload: ${err.message}` : 'Failed to complete upload'
        });
    }
});

app.post('/api/donations/abort', async (req, res) => {
    if (!ensureDonationsEnv(req, res)) return;

    const { key, uploadId } = req.body ?? {};
    if (!key || !uploadId) {
        return res.status(400).json({ error: 'key and uploadId are required' });
    }

    try {
        const command = new AbortMultipartUploadCommand({
            Bucket: DONATIONS_BUCKET_NAME,
            Key: key,
            UploadId: uploadId
        });
        await s3Client.send(command);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to abort upload: ${err.message}` : 'Failed to abort upload'
        });
    }
});

app.get('/api/donations/list', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureDonationsEnv(req, res)) return;

    try {
        const command = new ListObjectsV2Command({
            Bucket: DONATIONS_BUCKET_NAME,
            Prefix: 'donation/'
        });
        const result = await s3Client.send(command);
        const items = (result.Contents || [])
            .filter(o => o.Key && o.Key.toLowerCase().endsWith('.zip'))
            .map(o => ({
                key: o.Key,
                lastModified: o.LastModified ? o.LastModified.toISOString() : null,
                size: typeof o.Size === 'number' ? o.Size : null
            }))
            .sort((a, b) => {
                const at = a.lastModified ? Date.parse(a.lastModified) : 0;
                const bt = b.lastModified ? Date.parse(b.lastModified) : 0;
                return bt - at;
            });

        res.json({ items });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to list donations: ${err.message}` : 'Failed to list donations'
        });
    }
});

app.get('/api/donations/download-url', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureDonationsEnv(req, res)) return;

    const key = String(req.query.key || '');
    if (!key || !key.startsWith('donation/') || !key.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Invalid key' });
    }

    try {
        if (DONATIONS_PUBLIC_DOMAIN) {
            const url = `${DONATIONS_PUBLIC_DOMAIN}/${encodeURIComponent(key)}`;
            return res.json({ url });
        }

        const command = new GetObjectCommand({
            Bucket: DONATIONS_BUCKET_NAME,
            Key: key
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate download link' });
    }
});

function encodeKeyForPublicUrl(key) {
    return encodeURIComponent(key).replace(/%2F/g, '/');
}

app.get('/api/storage/list', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureUploadEnv(req, res)) return;

    const prefix = String(req.query.prefix || '');
    if (prefix.includes('..')) {
        return res.status(400).json({ error: 'Invalid prefix' });
    }

    try {
        const command = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            Prefix: prefix || undefined,
            Delimiter: '/'
        });
        const result = await s3Client.send(command);

        const folders = (result.CommonPrefixes || [])
            .map(p => p.Prefix)
            .filter(Boolean);

        const objects = (result.Contents || [])
            .filter(o => o.Key && o.Key !== prefix && !o.Key.endsWith('/'))
            .map(o => ({
                key: o.Key,
                lastModified: o.LastModified ? o.LastModified.toISOString() : null,
                size: typeof o.Size === 'number' ? o.Size : null
            }));

        res.json({
            prefix,
            folders,
            objects,
            isTruncated: Boolean(result.IsTruncated)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            error: err?.message ? `Failed to list storage: ${err.message}` : 'Failed to list storage'
        });
    }
});

app.get('/api/storage/download-url', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureUploadEnv(req, res)) return;

    const key = String(req.query.key || '');
    if (!key || key.includes('..') || key.endsWith('/')) {
        return res.status(400).json({ error: 'Invalid key' });
    }

    try {
        if (process.env.R2_PUBLIC_DOMAIN) {
            const url = `${process.env.R2_PUBLIC_DOMAIN}/${encodeKeyForPublicUrl(key)}`;
            return res.json({ url });
        }

        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME,
            Key: key
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.json({ url });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to generate download link' });
    }
});

app.post('/api/storage/delete', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureUploadEnv(req, res)) return;

    const { key, prefix } = req.body ?? {};
    const bucket = process.env.R2_BUCKET_NAME;

    if (key) {
        const k = String(key);
        if (!k || k.includes('..') || k.endsWith('/')) {
            return res.status(400).json({ error: 'Invalid key' });
        }

        try {
            await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }));
            return res.json({ success: true, deleted: 1 });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to delete file' });
        }
    }

    if (prefix) {
        const p = String(prefix);
        if (!p || p.includes('..')) {
            return res.status(400).json({ error: 'Invalid prefix' });
        }

        try {
            let deleted = 0;
            let continuationToken = undefined;

            while (true) {
                const list = await s3Client.send(new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: p,
                    ContinuationToken: continuationToken
                }));

                const keys = (list.Contents || [])
                    .map(o => o.Key)
                    .filter(Boolean)
                    .filter(k => !k.endsWith('/'));

                for (let i = 0; i < keys.length; i += 1000) {
                    const batch = keys.slice(i, i + 1000).map(Key => ({ Key }));
                    const out = await s3Client.send(new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: { Objects: batch, Quiet: true }
                    }));
                    deleted += Array.isArray(out.Deleted) ? out.Deleted.length : batch.length;
                }

                if (!list.IsTruncated) break;
                continuationToken = list.NextContinuationToken;
                if (!continuationToken) break;
            }

            return res.json({ success: true, deleted });
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to delete folder' });
        }
    }

    res.status(400).json({ error: 'key or prefix is required' });
});

app.post('/api/github/images', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureGithubEnv(req, res)) return;

    const { title, contentType, base64 } = req.body ?? {};
    if (!title || typeof title !== 'string') {
        return res.status(400).json({ error: 'title is required' });
    }
    if (!contentType || typeof contentType !== 'string') {
        return res.status(400).json({ error: 'contentType is required' });
    }
    if (!base64 || typeof base64 !== 'string') {
        return res.status(400).json({ error: 'base64 is required' });
    }
    if (!/^image\/(png|jpeg|jpg)$/i.test(contentType)) {
        return res.status(400).json({ error: 'Only png/jpg/jpeg allowed' });
    }

    const ext = contentType.toLowerCase().includes('png') ? 'png' : 'jpeg';
    const name = `${sanitizeImageBasename(title)}.${ext}`;
    const filePath = `${GITHUB_IMAGES_PATH.replace(/\/+$/, '')}/${name}`;

    let buffer;
    try {
        buffer = Buffer.from(base64, 'base64');
    } catch {
        return res.status(400).json({ error: 'Invalid base64' });
    }
    if (!buffer || buffer.length === 0) {
        return res.status(400).json({ error: 'Empty file' });
    }
    if (buffer.length > 8 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image too large (max 8MB)' });
    }

    const getUrl = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const existing = await githubRequest(getUrl, { method: 'GET' });
    const sha = existing.ok && existing.json && typeof existing.json.sha === 'string' ? existing.json.sha : undefined;

    const putUrl = `https://api.github.com/repos/${encodeURIComponent(GITHUB_OWNER)}/${encodeURIComponent(GITHUB_REPO)}/contents/${encodeURIComponent(filePath)}`;
    const payload = {
        message: `Upload image: ${name}`,
        content: buffer.toString('base64'),
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {})
    };

    const saved = await githubRequest(putUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!saved.ok) {
        return res.status(500).json({
            error: saved.json?.message || `GitHub upload failed (${saved.status})`
        });
    }

    const url = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${filePath}?raw=true`;
    res.json({ url, path: filePath });
});

app.get('/api/donations/download', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!ensureDonationsEnv(req, res)) return;

    const key = String(req.query.key || '');
    if (!key || !key.startsWith('donation/') || !key.toLowerCase().endsWith('.zip')) {
        return res.status(400).send('Invalid key');
    }

    try {
        if (DONATIONS_PUBLIC_DOMAIN) {
            const url = `${DONATIONS_PUBLIC_DOMAIN}/${encodeURIComponent(key)}`;
            return res.redirect(302, url);
        }

        const command = new GetObjectCommand({
            Bucket: DONATIONS_BUCKET_NAME,
            Key: key
        });
        const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        res.redirect(302, presignedUrl);
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to generate download link');
    }
});

// The Speed Engine: Redirect to Global CDN
app.get('/api/download/:id', async (req, res) => {
    const games = await readDB();
    const reqId = String(req.params.id || '');
    const game = games.find(g => g.publicId === reqId) || games.find(g => g.id === reqId);
    
    if (!game) {
        return res.status(404).send('Game not found');
    }

    try {
        const hashId = String(game.hashId || '').trim().toLowerCase();
        const title = String(game.title || '').trim();
        const fileKey = /^[a-f0-9]{32}$/.test(hashId)
            ? `${hashId}.zip`
            : (title.toLowerCase().endsWith('.zip') ? title : `${title}.zip`);
        
        // If you set up a custom domain on your Cloudflare R2 bucket (highly recommended for speed),
        // we redirect straight to that domain. This ensures the user hits the nearest Cloudflare Edge node.
        if (process.env.R2_PUBLIC_DOMAIN) {
            // Encode the title so spaces become %20, e.g., "Marvels_Deadpool_VR.zip" stays valid
            const publicUrl = `${process.env.R2_PUBLIC_DOMAIN}/${encodeURIComponent(fileKey)}`;
            return res.redirect(302, publicUrl);
        }

        // FALLBACK: If no public domain is set, generate a presigned URL using the AWS SDK.
        const command = new GetObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME || 'quest-archive',
            Key: fileKey
        });

        // Generate URL valid for 1 hour (3600 seconds)
        const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        
        // 302 Redirect to the Cloudflare R2 file
        res.redirect(302, presignedUrl);
    } catch (err) {
        console.error('Error generating download link:', err);
        res.status(500).send('Error generating download link');
    }
});

// Simple health check route for UptimeRobot
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/database', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'database.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
