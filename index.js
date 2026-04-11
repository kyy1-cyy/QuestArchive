import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = "mounir1359"; // Must match the secret in the Electron app
const ALLOWED_DOMAIN = "questarchive.xyz";

app.use(cors());
app.use(express.json());

// --- ADVANCED SECURITY MIDDLEWARE ---
const secureHandshake = (req, res, next) => {
    const signature = req.headers['x-qaaa-signature'];
    const timestamp = req.headers['x-qaaa-timestamp'];
    const clientKey = req.headers['x-qaaa-client'];
    const host = req.headers['host'];

    // 1. Force the domain (Prevents direct IP scraping/scanning)
    if (host && !host.includes(ALLOWED_DOMAIN)) {
        console.warn(`[SECURITY] Invalid Host: ${host}. Connection dropped.`);
        return res.status(404).json({ error: "Access Denied" }); // 404 to confuse scanners
    }

    // 2. Validate basic secret
    if (clientKey !== SECRET_KEY) {
        console.warn(`[SECURITY] Blocked UNAUTHORIZED request from ${req.ip}`);
        return res.status(403).json({ error: "Unauthorized Client Signature" });
    }

    // 3. Verify Rolling Ticket (HMAC)
    if (!signature || !timestamp) {
        return res.status(403).json({ error: "Missing Security Headers" });
    }

    // 4. Time-Window Check (Strict 60-second window to prevent Replay Attacks)
    const now = Math.floor(Date.now() / 1000);
    const diff = Math.abs(now - parseInt(timestamp));
    if (diff > 60) {
        return res.status(403).json({ error: "Handshake Expired" });
    }

    // 5. Signature Match
    const expectedPayload = `${timestamp}:${req.method}:${req.path}`;
    const expectedSignature = crypto.createHmac('sha256', SECRET_KEY)
                                    .update(expectedPayload)
                                    .digest('hex');

    if (signature !== expectedSignature) {
        console.error(`[SECURITY] SIGNATURE MATCH FAILED for ${req.ip}`);
        return res.status(403).json({ error: "Security Breach: Invalid Token" });
    }

    next();
};

// --- ROUTES ---
app.get('/boot.json', secureHandshake, (req, res) => {
    const mirrors = JSON.parse(fs.readFileSync(path.join(__dirname, 'boot.json'), 'utf8'));
    res.json(mirrors);
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

// Koyeb Health Check (Public)
app.get('/', (req, res) => {
    res.send('QAAA Secure Node - Online');
});

app.listen(PORT, () => {
    console.log(`[SYS] QAAA Secure Distribution Node ARMED on PORT ${PORT}`);
});
