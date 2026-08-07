const { contextBridge, ipcRenderer } = require('electron');

/**
 * Exposes the converter API to the renderer process.
 * The API provides methods for file/folder picking, job queue management, and subscription to job updates.
 */
contextBridge.exposeInMainWorld('converterApi', {
    pickFile: () => ipcRenderer.invoke('dialog:pick-file'),
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
    enqueue: (payload) => ipcRenderer.invoke('queue:enqueue', payload),
    getSnapshot: () => ipcRenderer.invoke('queue:get-snapshot'),
    cancelJob: (jobId) => ipcRenderer.invoke('queue:cancel-job', jobId),
    stopAll: () => ipcRenderer.invoke('queue:stop-all'),
    subscribe: (handlers) => {
        const onJobUpdated = (_event, job) => {
            if (handlers && typeof handlers.onJobUpdated === 'function') {
                handlers.onJobUpdated(job);
            }
        };

        const onStatsUpdated = (_event, stats) => {
            if (handlers && typeof handlers.onStatsUpdated === 'function') {
                handlers.onStatsUpdated(stats);
            }
        };

        ipcRenderer.on('queue:job-updated', onJobUpdated);
        ipcRenderer.on('queue:stats-updated', onStatsUpdated);
        ipcRenderer.send('queue:subscribe');

        return () => {
            ipcRenderer.removeListener('queue:job-updated', onJobUpdated);
            ipcRenderer.removeListener('queue:stats-updated', onStatsUpdated);
        };
    }
});
