"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BullManager = void 0;
const bullmq_1 = require("bullmq");
const BullBoard = __importStar(require("bull-board"));
const bullMQAdapter_1 = require("bull-board/bullMQAdapter");
const express_1 = __importDefault(require("express"));
class BullManager {
    constructor(container, Logger, config, jobs) {
        this.container = container;
        this.Logger = Logger;
        this.config = config;
        this.jobs = jobs;
        this._shutdowns = [];
    }
    get queues() {
        if (this._queues) {
            return this._queues;
        }
        this._queues = this.jobs.reduce((queues, path) => {
            const jobDefinition = this.container.make(path);
            const queueConfig = {
                connection: this.config.connections[this.config.connection],
                defaultJobOptions: jobDefinition.options,
                ...jobDefinition.queueOptions,
            };
            const jobListeners = this._getEventListener(jobDefinition);
            // eslint-disable-next-line no-new
            new bullmq_1.QueueScheduler(jobDefinition.key, queueConfig);
            queues[jobDefinition.key] = Object.freeze({
                bull: new bullmq_1.Queue(jobDefinition.key, queueConfig),
                ...jobDefinition,
                instance: jobDefinition,
                listeners: jobListeners,
                boot: jobDefinition.boot,
            });
            return queues;
        }, {});
        return this.queues;
    }
    _getEventListener(job) {
        const jobListeners = Object.getOwnPropertyNames(Object.getPrototypeOf(job)).reduce((events, method) => {
            if (method.startsWith('on')) {
                const eventName = method
                    .replace(/^on(\w)/, (_, group) => group.toLowerCase())
                    .replace(/([A-Z]+)/, (_, group) => ` ${group.toLowerCase()}`);
                events.push({ eventName, method });
            }
            return events;
        }, []);
        return jobListeners;
    }
    getByKey(key) {
        return this.queues[key];
    }
    add(key, data, jobOptions) {
        return this.getByKey(key).bull.add(key, data, jobOptions);
    }
    schedule(key, data, date, options) {
        const delay = typeof date === 'number' ? date : date.getTime() - Date.now();
        if (delay <= 0) {
            throw new Error('Invalid schedule time');
        }
        return this.add(key, data, { ...options, delay });
    }
    async remove(key, jobId) {
        const job = await this.getByKey(key).bull.getJob(jobId);
        return job?.remove();
    }
    /* istanbul ignore next */
    ui(port = 9999, prefix = '/bull-server') {
        const board = BullBoard.createBullBoard(Object.keys(this.queues).map((key) => new bullMQAdapter_1.BullMQAdapter(this.getByKey(key).bull)));
        console.log('custom adonis bull package');
        const app = express_1.default();
        app.use(prefix, board.router);
        const server = app.listen(port, () => {
            this.Logger.info(`bull board on http://localhost:${port}`);
        });
        const shutdown = async () => {
            await server.close(() => {
                this.Logger.info('Stopping bull board server');
            });
        };
        this._shutdowns = [...this._shutdowns, shutdown];
    }
    process() {
        this.Logger.info('Queue processing started');
        const shutdowns = Object.keys(this.queues).map((key) => {
            const jobDefinition = this.getByKey(key);
            if (typeof jobDefinition.boot !== 'undefined') {
                jobDefinition.boot(jobDefinition.bull);
            }
            const workerOptions = {
                concurrency: jobDefinition.concurrency ?? 1,
                connection: this.config.connections[this.config.connection],
                ...jobDefinition.workerOptions,
            };
            const processor = async (job) => {
                try {
                    return await jobDefinition.instance.handle(job);
                }
                catch (error) {
                    await this.handleException(error, job);
                    return Promise.reject(error);
                }
            };
            const worker = new bullmq_1.Worker(key, processor, workerOptions);
            jobDefinition.listeners.forEach(function (item) {
                worker.on(item.eventName, jobDefinition.instance[item.method].bind(jobDefinition.instance));
            });
            const shutdown = () => Promise.all([jobDefinition.bull.close(), worker.close()]);
            return shutdown;
        });
        this._shutdowns = [...this._shutdowns, ...shutdowns];
        return this;
    }
    async handleException(error, job) {
        try {
            const resolver = this.container.getResolver(undefined, 'exceptions', 'App/Exceptions');
            const resolvedPayload = resolver.resolve('BullHandler.handle');
            await resolver.call(resolvedPayload, undefined, [error, job]);
        }
        catch (err) {
            this.Logger.error(`name=${job.name} id=${job.id}`);
        }
    }
    async shutdown() {
        await Promise.all(this._shutdowns.map((shutdown) => shutdown()));
    }
}
exports.BullManager = BullManager;
