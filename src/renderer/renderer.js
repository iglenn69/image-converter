const state = {
  selectedPath: '',
  selectedKind: null,
  jobs: new Map(),
  stats: {
    total: 0,
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0
  }
};

const sourceInput = document.getElementById('source');
const outputDirInput = document.getElementById('output-dir');
const formatSelect = document.getElementById('format');
const bitDepthSelect = document.getElementById('bit-depth');
const queueList = document.getElementById('queue-list');

const statEls = {
  total: document.getElementById('stat-total'),
  queued: document.getElementById('stat-queued'),
  processing: document.getElementById('stat-processing'),
  completed: document.getElementById('stat-completed'),
  failed: document.getElementById('stat-failed'),
  cancelled: document.getElementById('stat-cancelled')
};

document.getElementById('pick-file').addEventListener('click', async () => {
  const picked = await window.converterApi.pickFile();
  if (picked) {
    state.selectedPath = picked;
    state.selectedKind = 'file';
    sourceInput.value = picked;
  }
});

document.getElementById('pick-folder').addEventListener('click', async () => {
  const picked = await window.converterApi.pickFolder();
  if (picked) {
    state.selectedPath = picked;
    state.selectedKind = 'folder';
    sourceInput.value = picked;
  }
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
    ? [{ sourcePath: state.selectedPath, outputDir, targetFormat: formatSelect.value, bitDepth: bitDepthSelect.value }]
    : [{ sourcePath: state.selectedPath, outputDir, targetFormat: formatSelect.value, bitDepth: bitDepthSelect.value }];

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

function renderStats() {
  for (const [key, value] of Object.entries(state.stats)) {
    if (statEls[key]) {
      statEls[key].textContent = String(value);
    }
  }
}

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
    title.textContent = job.sourcePath;

    const status = document.createElement('span');
    status.className = 'status-chip';
    status.textContent = `${job.status} (${job.stage})`;

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

    queueList.appendChild(li);
  }
}

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

(async function bootstrap() {
  const snapshot = await window.converterApi.getSnapshot();
  state.stats = snapshot.stats;
  for (const job of snapshot.jobs) {
    state.jobs.set(job.id, job);
  }
  renderStats();
  renderJobs();
})();
