import { S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';

// Main B2 client (games, database, logs, storage)
export const s3Client = new S3Client({
    region: 'us-west-004',
    endpoint: config.B2.ENDPOINT || undefined,
    credentials: {
        accessKeyId: config.B2.KEY_ID,
        secretAccessKey: config.B2.APP_KEY
    },
    forcePathStyle: true
});

// Download client (uses Cloudflare Proxy domain if set)
export const s3DownloadClient = new S3Client({
    region: 'us-west-004',
    // If DOWNLOAD_BASE_URL is set, use it as the endpoint to get free CF bandwidth
    endpoint: config.B2.DOWNLOAD_BASE_URL || config.B2.ENDPOINT || undefined,
    credentials: {
        accessKeyId: config.B2.KEY_ID,
        secretAccessKey: config.B2.APP_KEY
    },
    forcePathStyle: true
});

// Donations B2 client (separate bucket + credentials)
export const s3DonationsClient = new S3Client({
    region: 'us-west-004',
    endpoint: config.DONATIONS.ENDPOINT || undefined,
    credentials: {
        accessKeyId: config.DONATIONS.KEY_ID,
        secretAccessKey: config.DONATIONS.APP_KEY
    },
    forcePathStyle: true
});
