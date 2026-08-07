const fs = require('fs/promises');
const path = require('path');

const SIGNATURES = [
    { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { format: 'jpg', bytes: [0xff, 0xd8, 0xff] },
    { format: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
    { format: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], offsetCheck: (buffer) => buffer.slice(8, 12).toString('ascii') === 'WEBP' },
    { format: 'bmp', bytes: [0x42, 0x4d] },
    { format: 'tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
    { format: 'tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
    { format: 'avif', bytes: [0x66, 0x74, 0x79, 0x70], offsetCheck: (buffer) => buffer.slice(8, 12).toString('ascii').startsWith('avif') },
    {
        format: 'heic', bytes: [0x66, 0x74, 0x79, 0x70], offsetCheck: (buffer) => {
            const brand = buffer.slice(8, 12).toString('ascii');
            return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
        }
    }
];

const IMAGE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif', '.dng', '.raw'
]);

/**
 * Function to normalize the detected image format.
 * Converts 'jpeg' to 'jpg' and 'tif' to 'tiff'.
 * 
 * @param {string} format - The detected image format.
 * @returns {string} - The normalized image format.
 */
function normalizeDetectedFormat(format) {
    if (format === 'jpeg') {
        return 'jpg';
    }

    if (format === 'tif') {
        return 'tiff';
    }

    return format;
}

/**
 * Function to detect the image format from a buffer.
 * 
 * @param {Buffer} buffer - The buffer containing the image data.
 * @returns {string|null} - The detected image format or null if not recognized.
 */
function detectFormatFromBuffer(buffer) {
    for (const signature of SIGNATURES) {
        if (buffer.length < signature.bytes.length) {
            continue;
        }

        let match = true;
        for (let index = 0; index < signature.bytes.length; index += 1) {
            if (buffer[index] !== signature.bytes[index]) {
                match = false;
                break;
            }
        }

        if (!match) {
            continue;
        }

        if (typeof signature.offsetCheck === 'function' && !signature.offsetCheck(buffer)) {
            continue;
        }

        return signature.format;
    }

    return null;
}

/**
 * Function to detect the image type of a file based on its content or extension.
 * 
 * @param {string} filePath - The path to the image file.
 * @returns {string|null} - The detected image format or null if not recognized.
 */
async function detectImageType(filePath) {
    const handle = await fs.open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(32);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const type = detectFormatFromBuffer(buffer.slice(0, bytesRead));
        if (type) {
            return type;
        }
    } finally {
        await handle.close();
    }

    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.jpeg') {
        return 'jpg';
    }

    return IMAGE_EXTENSIONS.has(extension) ? normalizeDetectedFormat(extension.slice(1)) : null;
}

/**
 * Function to check if a given path is a directory.
 * 
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>} - True if the path is a directory, false otherwise.
 */
async function isDirectory(filePath) {
    try {
        return (await fs.stat(filePath)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Function to generate the output file name based on the source path and target format.
 * 
 * @param {string} sourcePath - The path to the source image file.
 * @param {string} targetFormat - The target image format.
 * @returns {string} - The generated output file name.
 */
function getOutputFileName(sourcePath, targetFormat) {
    const parsed = path.parse(sourcePath);
    return `${parsed.name}.${targetFormat}`;
}

module.exports = {
    detectImageType,
    getOutputFileName,
    isDirectory
};