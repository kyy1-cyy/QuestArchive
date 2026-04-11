import crypto from 'crypto';

// These should be set in Koyeb Environment Variables for maximum security
const SECRET_KEY = process.env.SECRET_KEY || "mounir1359";
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || "questarchive.xyz";

export const secureHandshake = (req, res, next) => {
    const signature = req.headers['x-qaaa-signature'];
    const timestamp = req.headers['x-qaaa-timestamp'];
    const clientKey = req.headers['x-qaaa-client'];
    const host = req.headers['host'];

    // 1. BLOCK KOYEB.APP ACCESS
    // If someone hits xxx.koyeb.app directly, we kill the connection
    if (host && (host.includes('koyeb.app') || !host.includes(ALLOWED_DOMAIN))) {
        console.warn(`[SECURITY] Blocked direct access via: ${host}`);
        return res.status(403).json({ error: "Access Denied: Use Official Domain Only" });
    }

    // 2. TOKEN & SIGNATURE VERIFICATION
    if (clientKey !== SECRET_KEY || !signature || !timestamp) {
        return res.status(403).json({ error: "Unauthorized Scraper Detected" });
    }

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 60) {
        return res.status(403).json({ error: "Handshake Expired" });
    }

    const expectedPayload = `${timestamp}:${req.method}:${req.path}`;
    const expectedSignature = crypto.createHmac('sha256', SECRET_KEY)
                                    .update(expectedPayload)
                                    .digest('hex');

    if (signature !== expectedSignature) {
        return res.status(403).json({ error: "Security Breach: Invalid Signature" });
    }

    next();
};
