const path = require('path');
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { ConversionJobQueue } = require('./jobQueue');

const queue = new ConversionJobQueue();

/**
 * Creates the main application window with specified dimensions and web preferences.
 * The window loads the renderer's index.html file and sets up the preload script for secure communication between the main and renderer processes.
 * 
 * @returns {BrowserWindow} - The created BrowserWindow instance.
 */
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

/**
 * Sets up IPC handlers for various operations such as file/folder picking, job queue management, and subscription to job updates.
 * The handlers facilitate communication between the renderer process and the main process, allowing the renderer to request actions and receive updates.
 */
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

  /**
   * Handles the folder picking dialog.
   * Returns the selected folder path or null if the operation was canceled.
   */
  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  /**
   * Handles the enqueuing of conversion jobs.
   * Validates the payload and normalizes the job items before adding them to the queue.
   * Returns the enqueued jobs and the current queue statistics.
   */
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

  /**
   * Handles the retrieval of the current snapshot of the conversion job queue.
   * Returns the list of jobs and the current queue statistics.
   */
  ipcMain.handle('queue:get-snapshot', async () => {
    return {
      jobs: queue.getJobs(),
      stats: queue.getStats()
    };
  });

  /**
   * Handles the cancellation of a specific job in the conversion job queue.
   * Returns the result of the cancellation operation.
   */
  ipcMain.handle('queue:cancel-job', async (_event, jobId) => {
    return queue.cancelJob(String(jobId));
  });

  /**
   * Handles the stopping of all jobs in the conversion job queue.
   * Returns the result of the stop operation.
   */
  ipcMain.handle('queue:stop-all', async () => {
    return queue.stopAll();
  });

  /**
   * Subscribes to job updates and statistics from the conversion job queue.
   * The renderer process will receive updates via the 'queue:job-updated' and 'queue:stats-updated' events.
   */
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

/**
 * Initializes the application when it is ready.
 * Sets up IPC handlers and creates the main application window.
 */
app.whenReady().then(() => {
  setupIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});
/**
 * Quits the application when all windows are closed, except on macOS where it is common for applications to stay active until the user explicitly quits with Cmd + Q.
 * This behavior ensures that the application adheres to platform conventions and provides a consistent user experience across different operating systems. 
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
