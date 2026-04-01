import { S3Client } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import https from 'https';
import { config } from './config.js';

function regionForEndpoint(endpoint, fallback = 'us-west-004') {
    const value = String(endpoint || '').toLowerCase();
    if (value.includes('cloudflarestorage.com')) return 'auto';
    return fallback;
}

function ensureHttps(url) {
    if (!url) return undefined;
    const s = String(url).trim();
    if (s.startsWith('http://') || s.startsWith('https://')) return s;
    return `https://${s}`;
}

// Force IPv4 + longer timeouts to avoid B2 IPv6 connection issues
const httpAgent = new https.Agent({
    family: 4,
    keepAlive: true,
    maxSockets: 50,
    timeout: 36000000
});

const requestHandler = new NodeHttpHandler({
    httpsAgent: httpAgent,
    connectionTimeout: 600000,
    socketTimeout: 36000000
});

// Main B2 client (games, database, logs, storage)
export const s3Client = new S3Client({
    region: regionForEndpoint(config.B2.ENDPOINT),
    endpoint: ensureHttps(config.B2.ENDPOINT),
    credentials: {
        accessKeyId: config.B2.KEY_ID,
        secretAccessKey: config.B2.APP_KEY
    },
    forcePathStyle: true,
    requestHandler
});

// Donations B2 client (separate bucket + credentials)
export const s3DonationsClient = new S3Client({
    region: regionForEndpoint(config.DONATIONS.ENDPOINT),
    endpoint: ensureHttps(config.DONATIONS.ENDPOINT),
    credentials: {
        accessKeyId: config.DONATIONS.KEY_ID,
        secretAccessKey: config.DONATIONS.APP_KEY
    },
    forcePathStyle: true,
    requestHandler
});
