/**
 * 
export default {
    async fetch(request) {
        const url = new URL(request.url);

        // Handle CORS preflight (needed for Range headers from browser)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
                    'Access-Control-Allow-Headers': 'Range, Content-Type, Content-Length, Authorization, X-Amz-Date, X-Amz-Content-Sha256',
                    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
                    'Access-Control-Max-Age': '86400'
                }
            });
        }

        // Rewrite host to B2 S3 endpoint
        url.host = 's3.us-west-004.backblazeb2.com';

        const response = await fetch(url.toString(), {
            method: request.method,
            headers: request.headers,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined
        });

        // Clone response and add CORS headers
        const newResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
        newResponse.headers.set('Access-Control-Allow-Origin', '*');
        newResponse.headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');

        return newResponse;
    }
};
