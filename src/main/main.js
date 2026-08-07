const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { ConversionJobQueue } = require('./jobQueue');

const queue = new ConversionJobQueue();

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#f6f7f8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true
    }
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function setupIpcHandlers() {
  ipcMain.handle('dialog:pick-file', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: 'Images',
          extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'raw', 'dng']
        }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('queue:enqueue', async (_event, payload) => {
    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error('No jobs submitted.');
    }

    const normalized = payload.items.map((item) => ({
      sourcePath: String(item.sourcePath || ''),
      outputDir: String(item.outputDir || ''),
      targetFormat: String(item.targetFormat || 'png'),
      bitDepth: String(item.bitDepth || '8'),
      outputMode: String(item.outputMode || 'preserve')
    })).filter((item) => item.sourcePath.trim().length > 0);

    if (normalized.length === 0) {
      throw new Error('All jobs were empty.');
    }

    const jobs = await queue.enqueueMany(normalized);

    return {
      jobs,
      stats: queue.getStats()
    };
  });

  ipcMain.handle('queue:get-snapshot', async () => {
    return {
      jobs: queue.getJobs(),
      stats: queue.getStats()
    };
  });

  ipcMain.handle('queue:cancel-job', async (_event, jobId) => {
    return queue.cancelJob(String(jobId));
  });

  ipcMain.on('queue:subscribe', (event) => {
    const sendJob = (job) => {
      event.sender.send('queue:job-updated', job);
    };
    const sendStats = (stats) => {
      event.sender.send('queue:stats-updated', stats);
    };

    queue.on('job-updated', sendJob);
    queue.on('stats-updated', sendStats);

    event.sender.once('destroyed', () => {
      queue.off('job-updated', sendJob);
      queue.off('stats-updated', sendStats);
    });
  });
}

app.whenReady().then(() => {
  setupIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
