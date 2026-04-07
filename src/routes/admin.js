import express from 'express';
import { config } from '../utils/config.js';
import { readDB, writeDB, makePublicId, refreshBucketFileCache, checkFileInCache, getBucketFileCache, addFileToCache, parseQuestFilename } from '../utils/db.js';
import { requireAdmin, ensureEnv } from '../utils/auth.js';
import { ensureMd5MapFresh } from '../utils/md5-map.js';
import { logger } from '../utils/logger.js';
import { runMigration, getMigrationStatus } from '../utils/migration.js';
import { getPackageNameFromList } from '../utils/game-list.js';
import { readJsonFromB2, writeJsonToB2 } from '../utils/s3-helpers.js';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../utils/s3.js';

const router = express.Router();

router.get('/database', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
        const games = await readDB();
        res.json(games);
    } catch (err) {
        next(err);
    }
});

router.post('/database', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    
    const { title, version, description, thumbnailUrl, hashId, fileKey } = req.body;
    if (!title) {
        return res.status(400).json({ error: 'Title is required' });
    }

    const newGame = {
        id: makePublicId(),
        publicId: makePublicId(),
        title,
        version: version !== undefined ? version : null,
        description: description || '',
        thumbnailUrl: thumbnailUrl || '',
        hashId: hashId ? String(hashId).trim().toLowerCase() : null,
        fileKey: fileKey || null,
        lastUpdated: new Date().toISOString(),
        downloads: 0
    };

    try {
        const games = await readDB();
        games.push(newGame);
        await writeDB(games);
        res.status(201).json(newGame);
    } catch (err) {
        next(err);
    }
});

router.post('/database/bulk-add', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;

    const { games: incoming } = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Invalid payload' });

    try {
        const { hashId, readJsonFromB2 } = await import('../utils/s3-helpers.js');
        const db = await readDB();
        const cacheClones = await getBucketFileCache(); // Fast memory read
        
        const added = [];
        for (const item of incoming) {
            const { fileKey } = item;
            if (!fileKey || db.find(g => g.fileKey === fileKey)) continue;

            const { title, version } = parseQuestFilename(fileKey);
            const fileName = fileKey.split('/').pop();
            const baseName = fileName.replace(/\.zip$/i, '');

            const newGame = {
                id: makePublicId(),
                publicId: makePublicId(),
                title: item.title || title,
                version: item.version !== undefined ? item.version : version,
                description: '',
                thumbnailUrl: '',
                fileKey: fileKey,
                hashId: item.hashId || hashId(baseName),
                lastUpdated: new Date().toISOString(),
                downloads: 0
            };

            // 1. Automatic Metadata Lookup (Thumbs/Notes)
            try {
                const baseName = fileName.replace(/\.zip$/i, '');
                
                // Try to find package name by splitting the filename (usually the end part)
                // or just matching the baseName to possible thumbnail names
                const pkgMatch = fileName.match(/\[(.*?)\]/); // Many use [com.pkg.name]
                const pkg = pkgMatch ? pkgMatch[1] : baseName;

                const thumbKey = `.meta/thumbnails/${pkg}.jpg`;
                if (cacheClones.includes(thumbKey)) {
                    newGame.thumbnailUrl = thumbKey; 
                }

                const notesKey = `.meta/notes/${baseName}.txt`;
                if (cacheClones.includes(notesKey)) {
                    const notes = await readJsonFromB2(notesKey, null);
                    if (notes) newGame.description = typeof notes === 'string' ? notes : (notes.description || '');
                }
            } catch (e) {
                console.error('Metadata lookup failed for', fileKey, e);
            }

            db.push(newGame);
            added.push(newGame);
        }

        if (added.length > 0) await writeDB(db);
        res.json({ success: true, count: added.length, games: added });
    } catch (err) {
        next(err);
    }
});

router.post('/database/bulk-delete', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;

    const { ids } = req.body;
    if (!Array.isArray(ids)) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    try {
        let games = await readDB();
        games = games.filter(g => !ids.includes(g.id));
        await writeDB(games);
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
});

router.get('/inspect-zip/:hash', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { hash } = req.params;
    console.log(`List Inspect requested for hash: ${hash}`);
    try {
        const map = await readJsonFromB2(config.B2.MD5_MAP_KEY, {});
        const key = map[hash];
        if (!key) return res.status(404).json({ error: 'Hash not found in map' });
        
        const packageName = await getPackageNameFromList(key);
        res.json({ packageName });
    } catch (err) {
        next(err);
    }
});

router.get('/find-thumbnail/:packageName', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { packageName } = req.params;
    const key = `.meta/thumbnails/${packageName}.jpg`;
    try {
        const found = await checkFileInCache(key);
        res.json({ found, key });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

router.get('/game-notes/:filename', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    const { filename } = req.params;
    
    // Strip external .zip if provided
    const baseName = filename.replace(/\.zip$/i, '').trim();
    const key = `.meta/notes/${baseName}.txt`;
    
    try {
        const exists = await checkFileInCache(key);
        if (!exists) return res.json({ found: false });

        const { GetObjectCommand } = await import('@aws-sdk/client-s3');
        const command = new GetObjectCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: key
        });
        const response = await s3Client.send(command);
        if (!response.Body) return res.json({ found: false });
        
        const description = await streamToString(response.Body);
        res.json({ found: true, description: description.trim() });
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
            return res.json({ found: false });
        }
        console.error('Error fetching game notes:', err);
        res.status(500).json({ error: 'Failed to fetch game notes' });
    }
});

router.get('/pending-games', async (req, res, next) => {
    if (!requireAdmin(req, res)) return;
    try {
        const files = await getBucketFileCache();

        const pending = files
            .filter(f => String(f).toLowerCase().endsWith('.zip'))
            .map(f => ({
                filename: f,
                hashId: null // We now compute hashId in the backend on-demand during registration
            }))
            .sort((a, b) => String(a.filename).localeCompare(String(b.filename), undefined, { numeric: true, sensitivity: 'base' }));

        res.json(pending);
    } catch (err) {
        next(err);
    }
});

// Internal endpoint for upload.sh to notify the server of a new upload
router.post('/internal/register-upload', async (req, res) => {
    // Basic auth check if API_KEY is set
    const auth = req.headers.authorization;
    if (config.API_KEY && auth !== `Bearer ${config.API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { key } = req.body ?? {};
    if (!key) return res.status(400).json({ error: 'Key required' });

    console.log(`[INTERNAL] Received upload notification for: ${key}`);
    
    try {
        await addFileToCache(key);
        res.json({ success: true });
    } catch (err) {
        console.error('Incremental cache update failed:', err);
        res.status(500).json({ error: 'Failed' });
    }
});

export default router;
