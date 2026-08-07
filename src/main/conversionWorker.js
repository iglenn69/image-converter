const { parentPort, workerData } = require('worker_threads');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

/**
 * Function to convert an image based on the provided job data.
 * It reads the source image, optionally decodes HEIC images, processes the image using Sharp,
 * and writes the output to the specified path. Progress updates are sent back to the parent thread.
 * 
 * @param {*} job 
 * @returns 
 */
async function convert(job) {
    const startedAt = Date.now();
    const finalOutputPath = path.resolve(job.finalOutputPath || path.join(path.resolve(job.outputDir), job.outputPath || job.outputFileName));
    const outputPath = path.resolve(job.tempOutputPath || `${finalOutputPath}.partial`);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const inputStats = await fs.stat(job.sourcePath);
    const inputBuffer = await fs.readFile(job.sourcePath);
    sendProgress(15, 'reading');

    const detectedType = job.detectedType || null;
    let sourceBuffer = inputBuffer;

    if (detectedType === 'heic') {
        sendProgress(35, 'decoding-heic');
        const heicFormat = job.targetFormat === 'jpg' || job.targetFormat === 'jpeg' ? 'JPEG' : 'PNG';
        sourceBuffer = await heicConvert({
            buffer: inputBuffer,
            format: heicFormat,
            quality: 1
        });
    }

    sendProgress(45, 'preparing');
    let pipeline = sharp(sourceBuffer, { failOn: 'none' }).rotate();
    const targetFormat = normalizeFormat(job.targetFormat);
    const encoderOptions = buildEncoderOptions(targetFormat, job.bitDepth);

    sendProgress(60, 'encoding');
    pipeline = pipeline.toFormat(targetFormat, encoderOptions);

    const info = await pipeline.toFile(outputPath);
    sendProgress(90, 'writing');

    await fs.rm(finalOutputPath, { force: true });
    await fs.rename(outputPath, finalOutputPath);

    const outputStats = await fs.stat(finalOutputPath);
    const durationMs = Date.now() - startedAt;

    return {
        outputPath: finalOutputPath,
        inputBytes: inputStats.size,
        outputBytes: outputStats.size,
        durationMs,
        compressionRatio: outputStats.size > 0 ? Number((inputStats.size / outputStats.size).toFixed(2)) : null,
        sourceFormat: detectedType || null,
        outputFormat: info.format || targetFormat,
        width: info.width,
        height: info.height,
        channels: info.channels
    };
}

/**
 * Function to normalize the image format string.
 * Converts 'jpeg' to 'jpg' and ensures the format is in lowercase.
 * 
 * @param {string} format - The image format to normalize.
 * @returns {string} - The normalized image format.
 */
function normalizeFormat(format) {
    const normalized = String(format || 'png').toLowerCase();
    return normalized === 'jpeg' ? 'jpg' : normalized;
}

/**
 * Function to build encoder options for the specified target format and bit depth.
 * 
 * @param {string} targetFormat - The target image format.
 * @param {number} bitDepth - The desired bit depth for the image.
 * @returns {object} - The encoder options for the specified format and bit depth.
 */
function buildEncoderOptions(targetFormat, bitDepth) {
    const depth = Number(bitDepth) || 8;

    if (targetFormat === 'png') {
        return { compressionLevel: 9, bitdepth: depth >= 16 ? 16 : 8 };
    }

    if (targetFormat === 'tiff') {
        return { compression: 'lzw', bitdepth: depth >= 16 ? 16 : 8 };
    }

    if (targetFormat === 'webp') {
        return { quality: 90 };
    }

    if (targetFormat === 'avif') {
        return { quality: 45 };
    }

    if (targetFormat === 'jpg') {
        return { quality: 92 };
    }

    return {};
}

/**
 * Function to send progress updates back to the parent thread.
 * 
 * @param {number} progress - The progress percentage of the conversion.
 * @param {string} stage - The current stage of the conversion process.
 */
function sendProgress(progress, stage) {
    if (parentPort) {
        parentPort.postMessage({ type: 'progress', progress, stage });
    }
}
/**
 * Main function to execute the image conversion process.
 * It calls the convert function with the job data and handles any errors that may occur.
 * Progress updates and results are sent back to the parent thread. 
 */
async function main() {
    try {
        const result = await convert(workerData.job);
        if (parentPort) {
            parentPort.postMessage({ type: 'result', result });
        }
    } catch (error) {
        if (parentPort) {
            parentPort.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        }
    }
}

void main();