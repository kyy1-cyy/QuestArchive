import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

function regionForEndpoint(endpoint, fallback = 'us-west-004') {
    const value = String(endpoint || '').toLowerCase();
    if (value.includes('cloudflarestorage.com')) return 'auto';
    return fallback;
}

// Main B2 client (games, database, logs, storage)
export const s3Client = new S3Client({
    region: regionForEndpoint(config.B2.ENDPOINT),
    endpoint: config.B2.ENDPOINT || undefined,
    credentials: {
        accessKeyId: config.B2.KEY_ID,
        secretAccessKey: config.B2.APP_KEY
    },
    forcePathStyle: true
});

// Donations B2 client (separate bucket + credentials)
export const s3DonationsClient = new S3Client({
    region: regionForEndpoint(config.DONATIONS.ENDPOINT),
    endpoint: config.DONATIONS.ENDPOINT || undefined,
    credentials: {
        accessKeyId: config.DONATIONS.KEY_ID,
        secretAccessKey: config.DONATIONS.APP_KEY
    },
    forcePathStyle: true
});
