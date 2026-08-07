const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');
const { Worker } = require('worker_threads');
const { detectImageType, getOutputFileName } = require('./imageDetection');

class ConversionJobQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.jobsById = new Map();
    this.running = false;
    this.activeJobId = null;
    this.activeWorker = null;
    this.activeWorkerTempOutputPath = null;
    this.stopRequested = false;
    this.nextId = 1;
    this.stats = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      stopped: 0,
      skipped: 0
    };
  }

  async enqueueMany(items) {
    const jobs = [];

    for (const item of items) {
      const expanded = await this._expandItem(item);
      for (const entry of expanded.jobs) {
        const job = {
          id: String(this.nextId++),
          sourcePath: entry.sourcePath,
          sourceName: entry.sourceName,
          outputDir: item.outputDir,
          targetFormat: item.targetFormat,
          bitDepth: item.bitDepth,
          outputMode: item.outputMode,
          sourceFormat: entry.sourceFormat,
          outputFileName: entry.outputFileName,
          outputPath: entry.outputPath,
          inputBytes: entry.inputBytes,
          outputBytes: null,
          durationMs: null,
          compressionRatio: null,
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

      if (expanded.skipped > 0) {
        this.stats.skipped += expanded.skipped;
      }
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
      total: this.stats.queued + this.stats.processing + this.stats.completed + this.stats.failed + this.stats.cancelled + this.stats.stopped,
      active: this.activeJobId
    };
  }

  async stopAll() {
    this.stopRequested = true;

    const stoppedJobs = [];

    for (const jobId of [...this.queue]) {
      const job = this.jobsById.get(jobId);
      if (!job || job.status !== 'queued') {
        continue;
      }

      this.queue = this.queue.filter((id) => id !== jobId);
      job.status = 'stopped';
      job.stage = 'stopped';
      job.progress = 100;
      job.finishedAt = Date.now();
      this.stats.queued -= 1;
      this.stats.stopped += 1;
      stoppedJobs.push(this._publicJob(job));
    }

    if (this.activeWorker) {
      try {
        await this.activeWorker.terminate();
      } catch {
        // Ignore worker termination failures during graceful stop.
      }
    }

    await this._cleanupActiveWorkerOutput();

    const activeJob = this.activeJobId ? this.jobsById.get(this.activeJobId) : null;
    if (activeJob && activeJob.status === 'processing') {
      activeJob.status = 'stopped';
      activeJob.stage = 'stopped';
      activeJob.progress = 100;
      activeJob.finishedAt = Date.now();
      this.stats.processing = Math.max(0, this.stats.processing - 1);
      this.stats.stopped += 1;
      stoppedJobs.push(this._publicJob(activeJob));
    }

    this.activeJobId = null;
    this.activeWorker = null;
    this.activeWorkerTempOutputPath = null;
    this.running = false;

    for (const job of stoppedJobs) {
      this.emit('job-updated', job);
    }

    this.emit('stats-updated', this.getStats());

    return {
      ok: true,
      stopped: stoppedJobs.length
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
      if (this.stopRequested) {
        break;
      }

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
        const result = await this._runWorker(job);
        job.outputBytes = result.outputBytes;
        job.durationMs = result.durationMs;
        job.compressionRatio = result.compressionRatio;
        job.sourceFormat = result.sourceFormat || job.sourceFormat;
        job.outputFormat = result.outputFormat;
        job.outputPath = result.outputPath;
        job.width = result.width;
        job.height = result.height;
        job.channels = result.channels;

        job.status = 'completed';
        job.stage = 'done';
        job.progress = 100;
        job.finishedAt = Date.now();
        this.stats.processing -= 1;
        this.stats.completed += 1;
      } catch (error) {
        if (this.stopRequested) {
          if (job.status !== 'stopped') {
            job.status = 'stopped';
            job.stage = 'stopped';
            job.progress = 100;
            job.finishedAt = Date.now();
            this.stats.stopped += 1;
          }
        } else {
          job.status = 'failed';
          job.stage = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
          job.finishedAt = Date.now();
          this.stats.failed += 1;
        }
        this.stats.processing = Math.max(0, this.stats.processing - 1);
      }

      this.emit('job-updated', this._publicJob(job));
      this.emit('stats-updated', this.getStats());
      this.activeJobId = null;

      if (this.stopRequested) {
        break;
      }
    }

    this.running = false;
    this.stopRequested = false;
  }

  async _expandItem(item) {
    const sourcePath = path.resolve(item.sourcePath);
    const outputDir = path.resolve(item.outputDir);
    const entryStats = await fs.stat(sourcePath);

    if (!entryStats.isDirectory()) {
      const sourceFormat = await detectImageType(sourcePath);
      if (!sourceFormat) {
        return { jobs: [], skipped: 1 };
      }

      return {
        jobs: [this._buildExpandedJob(sourcePath, sourceFormat, entryStats.size, item.targetFormat, sourcePath, item.outputMode)],
        skipped: 0
      };
    }

    const jobs = [];
    let skipped = 0;
    const pendingDirectories = [sourcePath];

    while (pendingDirectories.length > 0) {
      const currentDirectory = pendingDirectories.pop();
      if (this._isPathInside(currentDirectory, outputDir)) {
        continue;
      }

      const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

      for (const entry of entries) {
        const absolutePath = path.join(currentDirectory, entry.name);
        if (this._isPathInside(absolutePath, outputDir)) {
          continue;
        }

        if (entry.isDirectory()) {
          pendingDirectories.push(absolutePath);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const sourceFormat = await detectImageType(absolutePath);
        if (!sourceFormat) {
          skipped += 1;
          continue;
        }

        const stats = await fs.stat(absolutePath);
        jobs.push(this._buildExpandedJob(absolutePath, sourceFormat, stats.size, item.targetFormat, sourcePath, item.outputMode));
      }
    }

    return { jobs, skipped };
  }

  _isPathInside(candidatePath, parentPath) {
    const resolvedCandidate = path.resolve(candidatePath);
    const resolvedParent = path.resolve(parentPath);
    if (resolvedCandidate === resolvedParent) {
      return true;
    }

    const relative = path.relative(resolvedParent, resolvedCandidate);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  _buildExpandedJob(sourcePath, sourceFormat, inputBytes, targetFormat, sourceRoot, outputMode = 'preserve') {
    const normalizedTargetFormat = this._normalizeTargetFormat(targetFormat);

    return {
      sourcePath,
      sourceName: path.basename(sourcePath),
      sourceFormat,
      inputBytes,
      outputMode: String(outputMode || 'preserve').toLowerCase(),
      outputFileName: getOutputFileName(sourcePath, normalizedTargetFormat),
      outputPath: this._resolveOutputPath(sourcePath, sourceRoot, normalizedTargetFormat, outputMode)
    };
  }

  _resolveOutputPath(sourcePath, sourceRoot, targetFormat, outputMode) {
    if (String(outputMode || 'preserve').toLowerCase() === 'flat') {
      return getOutputFileName(sourcePath, targetFormat);
    }

    const relativePath = path.relative(path.resolve(sourceRoot), path.resolve(sourcePath));
    const relativeDirectory = path.dirname(relativePath);
    const outputFileName = getOutputFileName(sourcePath, targetFormat);

    if (!relativeDirectory || relativeDirectory === '.') {
      return outputFileName;
    }

    return path.join(relativeDirectory, outputFileName);
  }

  _normalizeTargetFormat(format) {
    const normalized = String(format || 'png').toLowerCase();
    return normalized === 'jpeg' ? 'jpg' : normalized;
  }

  async _runWorker(job) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finalOutputPath = path.join(path.resolve(job.outputDir), job.outputPath || job.outputFileName);
      const tempOutputPath = `${finalOutputPath}.partial`;
      const worker = new Worker(path.join(__dirname, 'conversionWorker.js'), {
        workerData: {
          job: {
            sourcePath: job.sourcePath,
            outputDir: job.outputDir,
            targetFormat: this._normalizeTargetFormat(job.targetFormat),
            bitDepth: job.bitDepth,
            detectedType: job.sourceFormat,
            outputFileName: job.outputFileName,
            outputPath: job.outputPath,
            finalOutputPath,
            tempOutputPath
          }
        }
      });

      this.activeWorker = worker;
      this.activeWorkerTempOutputPath = tempOutputPath;

      const settleResolve = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const settleReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      worker.on('message', (message) => {
        if (message.type === 'progress') {
          job.stage = message.stage;
          job.progress = message.progress;
          this.emit('job-updated', this._publicJob(job));
          return;
        }

        if (message.type === 'result') {
          settleResolve(message.result);
        }

        if (message.type === 'error') {
          settleReject(new Error(message.error));
        }
      });

      worker.on('error', (error) => {
        settleReject(error);
      });

      worker.on('exit', (code) => {
        this.activeWorker = null;
        if (code !== 0 && this.stopRequested) {
          settleReject(new Error('Conversion stopped by user.'));
          return;
        }

        if (code !== 0) {
          settleReject(new Error(`Worker exited with code ${code}`));
        }
      });
    });
  }

  async _cleanupActiveWorkerOutput() {
    if (!this.activeWorkerTempOutputPath) {
      return;
    }

    try {
      await fs.rm(this.activeWorkerTempOutputPath, { force: true });
    } catch {
      // Ignore cleanup errors during graceful stop.
    }
  }

  _publicJob(job) {
    return {
      id: job.id,
      sourcePath: job.sourcePath,
      sourceName: job.sourceName,
      outputDir: job.outputDir,
      targetFormat: job.targetFormat,
      bitDepth: job.bitDepth,
      sourceFormat: job.sourceFormat,
      outputFileName: job.outputFileName,
      outputMode: job.outputMode,
      inputBytes: job.inputBytes,
      outputBytes: job.outputBytes,
      durationMs: job.durationMs,
      compressionRatio: job.compressionRatio,
      outputPath: job.outputPath,
      width: job.width,
      height: job.height,
      channels: job.channels,
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
