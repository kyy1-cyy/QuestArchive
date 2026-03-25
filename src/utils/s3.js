import { S3Client } from '@aws-sdk/client-s3';
import { config, getR2EndpointBase } from './config.js';

export const s3Client = new S3Client({
    region: 'auto',
    endpoint: getR2EndpointBase(config.R2.ENDPOINT),
    credentials: {
        accessKeyId: config.R2.ACCESS_KEY_ID,
        secretAccessKey: config.R2.SECRET_ACCESS_KEY
    }
});
