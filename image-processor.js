const fs = require('fs');
const path = require('path');
const glob = require('glob');
const axios = require('axios');
const sharp = require('sharp');
const winston = require('winston');
const sizeOf = require('image-size');
const { getColorFromURL } = require('color-thief-node');

const logger = winston.createLogger({
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
  },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: 'errors.log', 
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'combined.log',
      maxsize: 5242880,
      maxFiles: 5
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

const imageConfigs = {
  small: {
    maxWidth: 800,
    quality: 80,
    suffix: '-sm'
  },
  medium: {
    maxWidth: 1200,
    quality: 85,
    suffix: '-md'
  },
  large: {
    maxWidth: 1600,
    quality: 90,
    suffix: '-lg'
  }
};

const processingOptions = {
  sharpening: {
    sigma: 1.2,
    flat: 1.0,
    jagged: 2.0
  },
  compression: {
    effort: 6,
    smartSubsample: true,
    reductionEffort: 6
  },
  color: {
    saturation: 1.1,
    brightness: 1.0,
    contrast: 1.1
  }
};

async function withRetry(operation, maxRetries = 3, delay = 5000) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      
      const waitTime = delay * Math.pow(2, attempt - 1);
      logger.warn(`Attempt ${attempt} failed. Retrying in ${waitTime}ms...`, {
        error: error.message,
        attempt,
        waitTime
      });
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
  throw lastError;
}

async function analyzeImage(inputPath) {
  try {
    const metadata = await sharp(inputPath).metadata();
    const dimensions = sizeOf(inputPath);
    const stats = await sharp(inputPath).stats();
    
    return {
      format: metadata.format,
      dimensions: {
        width: dimensions.width,
        height: dimensions.height,
        aspectRatio: (dimensions.width / dimensions.height).toFixed(2)
      },
      size: fs.statSync(inputPath).size,
      colorStats: {
        isTransparent: metadata.hasAlpha,
        dominant: stats.dominant,
        entropy: stats.entropy
      },
      quality: metadata.quality,
      chromaSubsampling: metadata.chromaSubsampling,
      space: metadata.space
    };
  } catch (error) {
    logger.error('Image analysis failed:', {
      path: inputPath,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function optimizeImage(inputPath, config, analysis) {
  const { maxWidth, quality, suffix } = config;
  const outputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}${suffix}.webp`
  );

  try {
    let pipeline = sharp(inputPath);

    if (analysis.dimensions.width > maxWidth) {
      pipeline = pipeline.resize(maxWidth, null, {
        fit: 'inside',
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3
      });
    }

    pipeline = pipeline
      .sharpen(
        processingOptions.sharpening.sigma,
        processingOptions.sharpening.flat,
        processingOptions.sharpening.jagged
      )
      .modulate({
        brightness: processingOptions.color.brightness,
        saturation: processingOptions.color.saturation
      })
      .gamma(processingOptions.color.contrast);

    if (analysis.space !== 'srgb') {
      pipeline = pipeline.toColorspace('srgb');
    }

    await pipeline
      .webp({
        quality,
        ...processingOptions.compression,
        nearLossless: analysis.quality === 100,
        alpha: analysis.colorStats.isTransparent
      })
      .toFile(outputPath);

    const optimizedStats = await analyzeImage(outputPath);
    
    return {
      path: outputPath,
      ...optimizedStats
    };
  } catch (error) {
    logger.error('Image optimization failed:', {
      input: inputPath,
      config,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function cleanupImageMappings() {
  const stats = {
    removed: 0,
    retained: 0,
    errors: [],
    startTime: Date.now()
  };

  try {
    const mapFile = 'image-mappings.json';
    
    if (!fs.existsSync(mapFile)) {
      logger.warn('No image mappings file found');
      return stats;
    }

    // Read the current image mappings
    const imageMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

    // Get current list of images in the filesystem
    const existingImages = new Set(
      glob.sync('**/*.{jpg,jpeg,png,gif}', {
        ignore: ['node_modules/**', '.git/**', '**/processed/**']
      }).map(imagePath => path.basename(imagePath))
    );

    // Check each image in the mapping
    const updatedImageMap = {};
    
    for (const [imageName, imageData] of Object.entries(imageMap)) {
      try {
        if (existingImages.has(imageName)) {
          updatedImageMap[imageName] = imageData;
          stats.retained++;
        } else {
          logger.info(`Removing mapping for deleted image: ${imageName}`);
          stats.removed++;
        }
      } catch (error) {
        stats.errors.push({
          image: imageName,
          error: error.message,
          timestamp: new Date().toISOString()
        });
        logger.error(`Error processing ${imageName}:`, {
          error: error.message,
          stack: error.stack
        });
      }
    }

    // Write the updated mappings back to file
    fs.writeFileSync(mapFile, JSON.stringify(updatedImageMap, null, 2));
    
    const endTime = Date.now();
    const report = {
      ...stats,
      duration: `${((endTime - stats.startTime) / 1000).toFixed(2)}s`
    };

    logger.info('Cleanup completed', report);
    fs.writeFileSync('cleanup-report.json', JSON.stringify(report, null, 2));

    return report;

  } catch (error) {
    logger.error('Fatal error during cleanup:', {
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function processImages(apiKey) {
  const stats = {
    processed: 0,
    skipped: 0,
    failed: 0,
    totalSizeBefore: 0,
    totalSizeAfter: 0,
    errors: [],
    warnings: [],
    startTime: Date.now()
  };

  await cleanupImageMappings();

  try {
    let imageMap = {};
    const mapFile = 'image-mappings.json';
    
    if (fs.existsSync(mapFile)) {
      imageMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
    }

    const images = glob.sync('**/*.{jpg,jpeg,png,gif}', {
      ignore: ['node_modules/**', '.git/**', '**/processed/**']
    });

    logger.info(`Starting batch processing of ${images.length} images`);

    for (const imagePath of images) {
      const baseImageName = path.basename(imagePath);
      
      try {
        if (imageMap[baseImageName]) {
          logger.debug(`Skipping ${baseImageName}`, {
            reason: 'already_processed'
          });
          stats.skipped++;
          continue;
        }

        const analysis = await withRetry(() => analyzeImage(imagePath));
        stats.totalSizeBefore += analysis.size;

        const versions = {};
        for (const [size, config] of Object.entries(imageConfigs)) {
          logger.debug(`Creating ${size} version for ${baseImageName}`);
          
          const result = await withRetry(() => 
            optimizeImage(imagePath, config, analysis)
          );

          const formData = new FormData();
          formData.append('file', new Blob([fs.readFileSync(result.path)]), 
            path.basename(result.path));

          const response = await withRetry(() =>
            axios.post('https://api.fivemerr.com/v1/media/images', formData, {
              headers: {
                'Authorization': `${apiKey}`,
                'Content-Type': 'multipart/form-data'
              }
            })
          );

          if (response.data?.url) {
            versions[size] = {
              url: response.data.url,
              dimensions: result.dimensions,
              size: result.size,
              format: 'webp',
              optimizationStats: {
                compressionRatio: ((analysis.size - result.size) / analysis.size * 100).toFixed(2),
                originalFormat: analysis.format,
                colorProfile: result.space
              }
            };
            stats.totalSizeAfter += result.size;
          }

          fs.unlinkSync(result.path);
        }

        imageMap[baseImageName] = {
          versions,
          metadata: {
            original: {
              format: analysis.format,
              dimensions: analysis.dimensions,
              size: analysis.size,
              colorStats: analysis.colorStats
            },
            processedAt: new Date().toISOString()
          }
        };

        stats.processed++;
        
      } catch (error) {
        stats.failed++;
        stats.errors.push({
          image: baseImageName,
          error: error.message,
          timestamp: new Date().toISOString()
        });
        logger.error(`Failed to process ${baseImageName}`, {
          error: error.message,
          stack: error.stack
        });
      }
    }

    fs.writeFileSync(mapFile, JSON.stringify(imageMap, null, 2));
    
    const endTime = Date.now();
    const report = {
      ...stats,
      duration: `${((endTime - stats.startTime) / 1000).toFixed(2)}s`,
      compressionRatio: `${((stats.totalSizeBefore - stats.totalSizeAfter) / stats.totalSizeBefore * 100).toFixed(2)}%`,
      sizeSaved: `${((stats.totalSizeBefore - stats.totalSizeAfter) / 1048576).toFixed(2)}MB`
    };

    logger.info('Processing completed', report);
    fs.writeFileSync('processing-report.json', JSON.stringify(report, null, 2));

  } catch (error) {
    logger.error('Fatal error during processing:', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

module.exports = { processImages };
