import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { secureHandshake } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- ROUTES ---
app.get('/api/bootstrap', secureHandshake, (req, res) => {
    try {
        const mirrors = JSON.parse(fs.readFileSync(path.join(__dirname, 'boot.json'), 'utf8'));
        const primary = mirrors.active_mirrors[0].url;
        res.json({ base_url: primary });
    } catch (e) {
        res.status(500).json({ error: "Bootstrap Config Missing" });
    }
});

app.get('/meta.7z', secureHandshake, (req, res) => {
    const metaPath = path.join(__dirname, 'meta.7z');
    if (fs.existsSync(metaPath)) {
        console.log(`[DISTRO] Serving meta.7z to authorized client...`);
        res.download(metaPath);
    } else {
        res.status(404).json({ error: "Metadata Archive not found on this node" });
    }
});

// Koyeb Health Check (NOW SECURED)
app.get('/', secureHandshake, (req, res) => {
    res.send('QAAA Secure Node - Online');
});

app.listen(PORT, () => {
    console.log(`[SYS] QAAA Secure Distribution Node ARMED on PORT ${PORT}`);
});
