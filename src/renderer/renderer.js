const state = {
  selectedPath: '',
  selectedKind: null,
  outputModeTouched: false,
  stopInProgress: false,
  jobs: new Map(),
  stats: {
    total: 0,
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    stopped: 0,
    skipped: 0
  }
};

const sourceInput = document.getElementById('source');
const outputDirInput = document.getElementById('output-dir');
const formatSelect = document.getElementById('format');
const bitDepthSelect = document.getElementById('bit-depth');
const outputModeSelect = document.getElementById('output-mode');
const queueList = document.getElementById('queue-list');
const stopAllButton = document.getElementById('stop-all');
const OUTPUT_MODE_STORAGE_KEY = 'image-converter.outputMode';

const statEls = {
  total: document.getElementById('stat-total'),
  queued: document.getElementById('stat-queued'),
  processing: document.getElementById('stat-processing'),
  completed: document.getElementById('stat-completed'),
  failed: document.getElementById('stat-failed'),
  cancelled: document.getElementById('stat-cancelled')
  ,
  stopped: document.getElementById('stat-stopped'),
  skipped: document.getElementById('stat-skipped')
};

document.getElementById('pick-file').addEventListener('click', async () => {
  const picked = await window.converterApi.pickFile();
  if (picked) {
    state.selectedPath = picked;
    state.selectedKind = 'file';
    sourceInput.value = picked;
    applySmartOutputMode('file');
  }
});

document.getElementById('pick-folder').addEventListener('click', async () => {
  const picked = await window.converterApi.pickFolder();
  if (picked) {
    state.selectedPath = picked;
    state.selectedKind = 'folder';
    sourceInput.value = picked;
    applySmartOutputMode('folder');
  }
});

outputModeSelect.addEventListener('change', () => {
  state.outputModeTouched = true;
  localStorage.setItem(OUTPUT_MODE_STORAGE_KEY, outputModeSelect.value);
});

document.getElementById('enqueue').addEventListener('click', async () => {
  if (!state.selectedPath) {
    window.alert('Select a source file or folder first.');
    return;
  }

  const outputDir = outputDirInput.value.trim();
  if (!outputDir) {
    window.alert('Set an output directory.');
    return;
  }

  const items = state.selectedKind === 'folder'
    ? [{ sourcePath: state.selectedPath, outputDir, targetFormat: formatSelect.value, bitDepth: bitDepthSelect.value, outputMode: getOutputModeForQueue() }]
    : [{ sourcePath: state.selectedPath, outputDir, targetFormat: formatSelect.value, bitDepth: bitDepthSelect.value, outputMode: 'flat' }];

  try {
    const snapshot = await window.converterApi.enqueue({ items });
    for (const job of snapshot.jobs) {
      state.jobs.set(job.id, job);
    }
    state.stats = snapshot.stats;
    renderStats();
    renderJobs();
  } catch (error) {
    window.alert(`Unable to enqueue job: ${error.message}`);
  }
});

stopAllButton.addEventListener('click', async () => {
  if (state.stats.processing === 0 && state.stats.queued === 0) {
    return;
  }

  const confirmed = window.confirm(
    'Stop the current conversion batch? Active work will be terminated, queued jobs will be stopped, and partial output will be cleaned up.'
  );

  if (!confirmed) {
    return;
  }

  state.stopInProgress = true;
  const previousLabel = stopAllButton.textContent;
  stopAllButton.textContent = 'Stopping...';
  stopAllButton.disabled = true;

  try {
    await window.converterApi.stopAll();
  } catch (error) {
    window.alert(`Unable to stop conversions: ${error.message}`);
  } finally {
    state.stopInProgress = false;
    stopAllButton.textContent = previousLabel;
    renderStats();
  }
});

/**
 * Renders the current statistics of the conversion job queue to the UI.
 */
function renderStats() {
  for (const [key, value] of Object.entries(state.stats)) {
    if (statEls[key]) {
      statEls[key].textContent = String(value);
    }
  }

  stopAllButton.disabled = state.stopInProgress || (state.stats.processing === 0 && state.stats.queued === 0);
}

/**
 * Renders the list of conversion jobs in the queue to the UI.
 * Each job displays its status, progress, and relevant metadata.
 */
function renderJobs() {
  const jobs = Array.from(state.jobs.values())
    .sort((a, b) => a.createdAt - b.createdAt);

  queueList.innerHTML = '';

  for (const job of jobs) {
    const li = document.createElement('li');
    li.className = 'queue-item';

    const head = document.createElement('div');
    head.className = 'queue-head';

    const title = document.createElement('div');
    title.textContent = job.sourceName || job.sourcePath;

    const status = document.createElement('span');
    status.className = 'status-chip';
    status.textContent = `${job.status} (${job.stage})`;

    if (job.status === 'stopped') {
      status.style.background = 'rgba(67, 212, 154, 0.16)';
      status.style.color = '#7cf0bb';
      status.style.borderColor = 'rgba(67, 212, 154, 0.22)';
    }

    head.append(title, status);

    const meta = document.createElement('div');
    meta.className = 'queue-meta';
    meta.textContent = `${job.targetFormat} | ${job.bitDepth}-bit | output: ${job.outputDir}`;

    const progress = document.createElement('div');
    progress.className = 'progress';

    const bar = document.createElement('span');
    bar.style.width = `${Math.max(0, Math.min(100, job.progress || 0))}%`;
    progress.appendChild(bar);

    li.append(head, meta, progress);

    if (job.status === 'queued') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'danger';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', async () => {
        await window.converterApi.cancelJob(job.id);
      });
      li.appendChild(cancelBtn);
    }

    if (job.error) {
      const err = document.createElement('div');
      err.className = 'queue-meta';
      err.style.color = '#b03030';
      err.textContent = `Error: ${job.error}`;
      li.appendChild(err);
    }

    const details = document.createElement('div');
    details.className = 'queue-meta';
    const inputSize = formatBytes(job.inputBytes);
    const outputSize = formatBytes(job.outputBytes);
    const ratio = typeof job.compressionRatio === 'number' ? `${job.compressionRatio}x` : 'pending';
    const duration = typeof job.durationMs === 'number' ? `${job.durationMs} ms` : 'pending';
    const dimensions = job.width && job.height ? `${job.width}x${job.height}` : 'pending';
    const layout = job.outputMode === 'flat' ? 'flat' : 'tree';
    details.textContent = `${job.sourceFormat || 'unknown'} -> ${job.targetFormat} | ${dimensions} | ${layout} | input ${inputSize} | output ${outputSize} | ratio ${ratio} | duration ${duration}`;
    li.appendChild(details);

    if (job.outputPath) {
      const outputPath = document.createElement('div');
      outputPath.className = 'queue-meta';
      outputPath.textContent = `Saved to: ${job.outputPath}`;
      li.appendChild(outputPath);
    }

    if (job.status === 'stopped') {
      const stopped = document.createElement('div');
      stopped.className = 'queue-meta';
      stopped.style.color = '#7cf0bb';
      stopped.textContent = 'Stopped gracefully and cleaned up partial output.';
      li.appendChild(stopped);
    }

    queueList.appendChild(li);
  }
}

/**
 *  Formats a byte count into a human-readable string with appropriate units (B, KB, MB, GB).
 * 
 * @param {number} bytes - The number of bytes to format.
 * @returns {string} - The formatted string representing the size in appropriate units. 
 */
function formatBytes(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) {
    return 'pending';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

/**
 * Applies the smart output mode based on the selected kind (file or folder) and the saved output mode in local storage.
 *
 * @param {string} selectedKind - The kind of selection ('file' or 'folder').
 * @returns {void}
 */
function applySmartOutputMode(selectedKind) {
  const savedOutputMode = localStorage.getItem(OUTPUT_MODE_STORAGE_KEY);

  if (savedOutputMode === 'flat' || savedOutputMode === 'preserve') {
    outputModeSelect.value = savedOutputMode;
    return;
  }

  if (!state.outputModeTouched) {
    outputModeSelect.value = selectedKind === 'file' ? 'flat' : 'preserve';
  }
}

/**
 * Determines the output mode for the job queue based on the selected kind and user preference.
 *
 * @returns {string} - The output mode ('flat' or 'preserve') for the job queue.
 */     
 function getOutputModeForQueue() {
  if (state.selectedKind === 'folder') {
    return outputModeSelect.value;
  }

  return 'flat';
}

/**
 * Subscribes to job updates and statistics from the conversion job queue.
 * The renderer process will receive updates via the 'onJobUpdated' and 'onStatsUpdated' handlers.
 */
window.converterApi.subscribe({
  onJobUpdated: (job) => {
    state.jobs.set(job.id, job);
    renderJobs();
  },
  onStatsUpdated: (stats) => {
    state.stats = stats;
    renderStats();
  }
});

/**
 * Bootstraps the renderer process by applying the smart output mode,
 * retrieving the initial snapshot of the job queue, and rendering the UI.
 */ 
(async function bootstrap() {
  applySmartOutputMode('folder');
  const snapshot = await window.converterApi.getSnapshot();
  state.stats = snapshot.stats;
  for (const job of snapshot.jobs) {
    state.jobs.set(job.id, job);
  }
  renderStats();
  renderJobs();
})();
