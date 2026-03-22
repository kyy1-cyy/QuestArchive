import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    S3Client,
    GetObjectCommand,
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

// Helper to read DB
async function readDB() {
    try {
        const data = await fs.readFile(DB_PATH, 'utf-8');
        return data ? JSON.parse(data) : [];
    } catch (err) {
        if (err.code === 'ENOENT') {
            await fs.writeFile(DB_PATH, '[]');
            return [];
        }
        console.error('Error reading DB:', err);
        return [];
    }
}

// Helper to write DB
async function writeDB(data) {
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

// Routes
// Get all games
app.get('/api/games', async (req, res) => {
    const games = await readDB();
    res.json(games);
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
    
    const { title, version, description, thumbnailUrl } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    // Under the hood we just assign a unique timestamp ID to keep the JSON valid
    const newGame = {
        id: Date.now().toString(),
        title,
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

    const { filename, prefix } = req.body ?? {};
    if (!filename || typeof filename !== 'string') {
        return res.status(400).json({ error: 'filename is required' });
    }
    if (!filename.toLowerCase().endsWith('.zip')) {
        return res.status(400).json({ error: 'Only .zip files are allowed' });
    }

    const cleanFilename = filename.replace(/[\\/]/g, '_').trim();
    const cleanPrefix = (typeof prefix === 'string' ? prefix : '').trim().replace(/^\//, '').replace(/\\/g, '/');
    if (cleanPrefix.includes('..')) {
        return res.status(400).json({ error: 'Invalid prefix' });
    }
    const key = cleanPrefix ? `${cleanPrefix.replace(/\/+$/, '')}/${cleanFilename}` : cleanFilename;

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

// The Speed Engine: Redirect to Global CDN
app.get('/api/download/:id', async (req, res) => {
    const games = await readDB();
    const game = games.find(g => g.id === req.params.id);
    
    if (!game) {
        return res.status(404).send('Game not found');
    }

    try {
        // Look up the exact title in the bucket
        const fileKey = `${game.title}.apk`; 
        
        // If you set up a custom domain on your Cloudflare R2 bucket (highly recommended for speed),
        // we redirect straight to that domain. This ensures the user hits the nearest Cloudflare Edge node.
        if (process.env.R2_PUBLIC_DOMAIN) {
            // Encode the title so spaces become %20, e.g., "Beat Saber.apk" -> "Beat%20Saber.apk"
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
