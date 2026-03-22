import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure S3 Client for Cloudflare R2
const s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT, 
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

// Routes
// Get all games
app.get('/api/games', async (req, res) => {
    const games = await readDB();
    res.json(games);
});

// Admin Route: Get all games
app.get('/api/database', async (req, res) => {
    const { password } = req.headers;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const games = await readDB();
    res.json(games);
});

// Admin Route: Add Game
app.post('/api/database', async (req, res) => {
    const { password } = req.headers;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
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
    const { password } = req.headers;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

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
    const { password } = req.headers;
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    let games = await readDB();
    games = games.filter(g => g.id !== req.params.id);
    await writeDB(games);

    res.json({ success: true });
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