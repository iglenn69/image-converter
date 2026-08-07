const { parentPort, workerData } = require('worker_threads');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const heicConvert = require('heic-convert');

async function convert(job) {
  const startedAt = Date.now();
  const outputDir = path.resolve(job.outputDir);
  const outputPath = path.join(outputDir, job.outputPath || job.outputFileName);
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

  const outputStats = await fs.stat(outputPath);
  const durationMs = Date.now() - startedAt;

  return {
    outputPath,
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

function normalizeFormat(format) {
  const normalized = String(format || 'png').toLowerCase();
  return normalized === 'jpeg' ? 'jpg' : normalized;
}

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

function sendProgress(progress, stage) {
  if (parentPort) {
    parentPort.postMessage({ type: 'progress', progress, stage });
  }
}

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