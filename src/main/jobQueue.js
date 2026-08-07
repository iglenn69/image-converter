const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');

class ConversionJobQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.jobsById = new Map();
    this.running = false;
    this.activeJobId = null;
    this.nextId = 1;
    this.stats = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    };
  }

  enqueueMany(items) {
    const jobs = [];

    for (const item of items) {
      const job = {
        id: String(this.nextId++),
        sourcePath: item.sourcePath,
        outputDir: item.outputDir,
        targetFormat: item.targetFormat,
        bitDepth: item.bitDepth,
        status: 'queued',
        progress: 0,
        stage: 'queued',
        error: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null
      };

      this.queue.push(job.id);
      this.jobsById.set(job.id, job);
      jobs.push(job);
      this.stats.queued += 1;
      this.emit('job-updated', this._publicJob(job));
    }

    this.emit('stats-updated', this.getStats());
    this._startProcessing();

    return jobs.map((job) => this._publicJob(job));
  }

  getJobs() {
    return Array.from(this.jobsById.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((job) => this._publicJob(job));
  }

  getStats() {
    return {
      ...this.stats,
      total: this.stats.queued + this.stats.processing + this.stats.completed + this.stats.failed + this.stats.cancelled
    };
  }

  cancelJob(jobId) {
    const job = this.jobsById.get(jobId);
    if (!job) {
      return { ok: false, reason: 'not_found' };
    }

    if (job.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== jobId);
      job.status = 'cancelled';
      job.progress = 100;
      job.stage = 'cancelled';
      job.finishedAt = Date.now();
      this.stats.queued -= 1;
      this.stats.cancelled += 1;
      this.emit('job-updated', this._publicJob(job));
      this.emit('stats-updated', this.getStats());
      return { ok: true };
    }

    return { ok: false, reason: 'not_cancellable' };
  }

  _startProcessing() {
    if (this.running) {
      return;
    }
    this.running = true;
    void this._processingLoop();
  }

  async _processingLoop() {
    while (this.queue.length > 0) {
      const jobId = this.queue.shift();
      const job = this.jobsById.get(jobId);

      if (!job || job.status !== 'queued') {
        continue;
      }

      this.activeJobId = job.id;
      this.stats.queued -= 1;
      this.stats.processing += 1;

      job.status = 'processing';
      job.stage = 'preparing';
      job.startedAt = Date.now();
      job.progress = 5;
      this.emit('job-updated', this._publicJob(job));
      this.emit('stats-updated', this.getStats());

      try {
        await this._simulateJob(job, 'reading', 25, 150);
        await this._simulateJob(job, 'decoding', 50, 250);
        await this._simulateJob(job, 'encoding', 75, 300);

        if (job.outputDir) {
          await fs.mkdir(path.resolve(job.outputDir), { recursive: true });
        }

        await this._simulateJob(job, 'writing', 95, 150);

        job.status = 'completed';
        job.stage = 'done';
        job.progress = 100;
        job.finishedAt = Date.now();
        this.stats.processing -= 1;
        this.stats.completed += 1;
      } catch (error) {
        job.status = 'failed';
        job.stage = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = Date.now();
        this.stats.processing -= 1;
        this.stats.failed += 1;
      }

      this.emit('job-updated', this._publicJob(job));
      this.emit('stats-updated', this.getStats());
      this.activeJobId = null;
    }

    this.running = false;
  }

  async _simulateJob(job, stage, progress, delayMs) {
    job.stage = stage;
    job.progress = progress;
    this.emit('job-updated', this._publicJob(job));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  _publicJob(job) {
    return {
      id: job.id,
      sourcePath: job.sourcePath,
      outputDir: job.outputDir,
      targetFormat: job.targetFormat,
      bitDepth: job.bitDepth,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      error: job.error,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    };
  }
}

module.exports = {
  ConversionJobQueue
};
