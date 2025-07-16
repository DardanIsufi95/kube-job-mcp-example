import express from 'express';
import type {Request,Response} from 'express';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {SSEServerTransport} from '@modelcontextprotocol/sdk/server/sse.js';
import { z} from 'zod';
import * as k8s from '@kubernetes/client-node';

/* -------------------------- 🔧 Utility Logging -------------------------- */
const log = (msg: string, ...args: any[]) => console.log(`[${new Date().toISOString()}] ${msg}`, ...args);
const logError = (msg: string, ...args: any[]) => console.error(`[${new Date().toISOString()}] ${msg}`, ...args);
const logWarn = (msg: string, ...args: any[]) => console.warn(`[${new Date().toISOString()}] ${msg}`, ...args);

/* ------------------------- 🧠 Initialize MCP Server ------------------------- */
const server = new McpServer({
    name: 'fetcher',
    version: '1.0.0'
});

/* --------------------- ⚙️ Kubernetes Client Setup ---------------------- */
log('🔧 Loading Kubernetes configuration...');
const kc = new k8s.KubeConfig();
try {
    kc.loadFromDefault();
    log('✅ Kubernetes config loaded');
} catch (err) {
    logError('❌ Failed to load Kubernetes config:', err);
    throw err;
}
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const watchClient = new k8s.Watch(kc);
const NAMESPACE = process.env.K8S_NAMESPACE || 'default';
log(`🎯 Using namespace: ${NAMESPACE}`);

/* ------------------------ 🛠️ MCP Tool: fetch-url ------------------------ */
server.tool(
    'fetch-url',
    'Fetch HTML of a URL using a single pod', {
        url: z.string().url().describe('URL to fetch')
    },
    async ({
        url
    }) => {
        const podName = `fetch-pod-${Date.now()}`;
        log(`🚀 fetch-url called | Pod: ${podName} | URL: ${url}`);

        const podManifest: k8s.V1Pod = {
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
                name: podName
            },
            spec: {
                restartPolicy: 'Never',
                containers: [{
                    name: 'fetcher',
                    image: 'dardanisufi95/puppeteer-fetcher:latest',
                    args: [url]
                }]
            },
        };

        try {
            await coreV1Api.createNamespacedPod({
                namespace: NAMESPACE,
                body: podManifest
            });
            log(`📦 Pod ${podName} created`);
        } catch (err) {
            logError(`❌ Failed to create pod: ${podName}`, err);
            throw err;
        }

        await new Promise < void > ((resolve, reject) => {
            let requestRef: any;
            const timeout = setTimeout(() => {
                logWarn(`⏰ Timeout: Pod ${podName} exceeded 5 minutes`);
                requestRef?.abort();
                reject(new Error('Timeout'));
            }, 5 * 60 * 1000);

            watchClient.watch(
                `/api/v1/namespaces/${NAMESPACE}/pods`, {
                    fieldSelector: `metadata.name=${podName}`
                },
                (type, pod) => {
                    const phase = pod.status?.phase;
                    log(`📊 Pod ${podName} phase: ${phase}`);
                    if (['Succeeded', 'Failed'].includes(phase || '')) {
                        clearTimeout(timeout);
                        requestRef?.abort();
                        resolve();
                    }
                },
                (err) => {
                    if (err?.type !== 'aborted') {
                        clearTimeout(timeout);
                        logError(`❌ Watch error: ${podName}`, err);
                        reject(err);
                    }
                }
            ).then(req => {
                requestRef = req;
                log(`👀 Watching pod ${podName}`);
            }).catch(reject);
        });

        let html: string;
        try {
            html = await coreV1Api.readNamespacedPodLog({
                name: podName,
                namespace: NAMESPACE,
                container: 'fetcher',
            });
            log(`📝 Logs retrieved (${html.length} chars)`);
        } catch (err) {
            logError(`❌ Failed to fetch logs from ${podName}`, err);
            html = `Error retrieving logs: ${err}`;
        }

        try {
            await coreV1Api.deleteNamespacedPod({
                name: podName,
                namespace: NAMESPACE
            });
            log(`🧹 Pod ${podName} deleted`);
        } catch (err) {
            logWarn(`⚠️ Failed to delete pod ${podName}`, err);
        }

        return {
            content: [{
                type: 'text',
                text: html
            }]
        };
    }
);

/* -------------------- 🌐 Express + SSE Integration --------------------- */
const transports: Record < string, SSEServerTransport > = {};

async function main() {
    const app = express();
    app.use(express.json());

    const PORT = process.env.PORT || 3000;
    log(`🚀 Starting server on port ${PORT}`);

    app.get('/sse', async (req, res) => {
        const ip = req.ip;
        log(`🔌 New SSE connection from ${ip}`);

        try {
            const transport = new SSEServerTransport('/messages', res);
            transports[transport.sessionId] = transport;

            res.on('close', () => {
                delete transports[transport.sessionId];
                log(`🔌 SSE closed: ${transport.sessionId}`);
            });

            await server.connect(transport);
            log(`✅ Connected transport: ${transport.sessionId}`);
        } catch (err) {
            logError('❌ SSE connection error:', err);
            res.status(500).send('SSE setup failed');
        }
    });

    app.post('/messages', async (req, res) => {
        const sessionId = req.query.sessionId as string;
        const transport = transports[sessionId];
        log(`📨 Message for session: ${sessionId}`);

        if (!transport) {
            res.status(400).send('No transport found for sessionId');
            return;
        }

        try {
            await transport.handlePostMessage(req, res, req.body);
            log(`✅ Message processed for ${sessionId}`);
        } catch (err) {
            logError(`❌ Message handling error for ${sessionId}`, err);
            res.status(500).send('Message error');
        }
    });

    app.listen(PORT, () => {
        log(`🌍 Server ready at http://localhost:${PORT}`);
        log(`📡 SSE endpoint: /sse`);
        log(`📬 Message endpoint: /messages`);
    });
}

main().catch((err) => {
    logError('💥 Fatal error:', err);
    process.exit(1);
});