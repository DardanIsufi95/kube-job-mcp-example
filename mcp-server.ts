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
const batchV1Api = kc.makeApiClient(k8s.BatchV1Api);
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
        let podName = ``;
        const jobName = `fetch-job-${Date.now()}`;
        const jobManifest: k8s.V1Job = {
            apiVersion: 'batch/v1',
            kind: 'Job',
            metadata: { name: jobName },
            spec: {
                ttlSecondsAfterFinished: 60,
                backoffLimit: 0,
                template: {
                spec: {
                    restartPolicy: 'Never',
                    containers: [
                    {
                        name: 'fetcher',
                        image: 'dardanisufi95/puppeteer-fetcher:latest',
                        args: [url],
                    },
                    ],
                },
                },
            },
        };

        try {
            await batchV1Api.createNamespacedJob({
                namespace: NAMESPACE,
                body: jobManifest,
            });
            log(`📦 Job ${jobName} created`);
        } catch (err) {
            logError(`❌ Failed to create job: ${jobName}`, err);
            throw err;
        }

        await new Promise < void > ((resolve, reject) => {
            let requestRef: any;
            const timeout = setTimeout(() => {
                logWarn(`⏰ Timeout: Job ${jobName} exceeded 5 minutes`);
                requestRef?.abort();
                reject(new Error('Timeout'));
            }, 5 * 60 * 1000);

            watchClient.watch(
                `/api/v1/namespaces/${NAMESPACE}/pods`,
                { labelSelector: `job-name=${jobName}` },
                (type, pod) => {
                    const phase = pod.status?.phase;
                    podName = pod.metadata.name;
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
                        logError(`❌ Watch error: ${jobName}`, err);
                        reject(err);
                    }
                }
            ).then(req => {
                requestRef = req;
                log(`👀 Watching pod ${jobName}`);
            }).catch(reject);
        });

        let html: string;
        try {
            html =  await coreV1Api.readNamespacedPodLog({
                name: podName,
                namespace: NAMESPACE,
                container: 'fetcher',
            });
            log(`📝 Logs retrieved (${html.length} chars)`);
        } catch (err) {
            logError(`❌ Failed to fetch logs from ${jobName}`, err);
            html = `Error retrieving logs: ${err}`;
        }

        try {
            // await coreV1Api.deleteNamespacedPod({
            //     name: podName,
            //     namespace: NAMESPACE
            // });
            // log(`🧹 Pod ${podName} deleted`);
        } catch (err) {
            logWarn(`⚠️ Failed to delete pod ${jobName}`, err);
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