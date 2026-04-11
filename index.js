import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = "mounir1359"; // Internal Secure Handshake Key

app.use(cors());
app.use(express.json());

// --- SECURITY MIDDLEWARE ---
// Every request must have the X-QAAA-CLIENT header
const secureHandshake = (req, res, next) => {
    const clientHeader = req.headers['x-qaaa-client'];
    if (clientHeader !== SECRET_KEY) {
        console.warn(`[SECURITY] Blocked UNAUTHORIZED request from ${req.ip}`);
        return res.status(403).json({ error: "Unauthorized Client Signature" });
    }
    next();
};

// --- ROUTES ---

// 1. Handshake Endpoint (Used by App to get current node status)
app.get('/boot.json', secureHandshake, (req, res) => {
    const mirrors = JSON.parse(fs.readFileSync(path.join(__dirname, 'boot.json'), 'utf8'));
    res.json(mirrors);
});

// 2. Metadata Archive Endpoint
app.get('/meta.7z', secureHandshake, (req, res) => {
    const metaPath = path.join(__dirname, 'meta.7z');
    if (fs.existsSync(metaPath)) {
        console.log(`[DISTRO] Serving meta.7z to authorized client...`);
        res.download(metaPath);
    } else {
        res.status(404).json({ error: "Metadata Archive not found on this node" });
    }
});

// 3. Health Check (Public - just for Koyeb)
app.get('/', (req, res) => {
    res.send('QAAA Distribution Node - Online');
});

app.listen(PORT, () => {
    console.log(`
    -------------------------------------------
    QAAA SECURE DISTRIBUTION NODE
    Port: ${PORT}
    Status: ARMED & READY
    -------------------------------------------
    `);
});
