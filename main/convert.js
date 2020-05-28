/* eslint-disable array-element-newline */
'use strict';

const os = require('os');
const path = require('path');
const execa = require('execa');
const moment = require('moment');
const prettyMs = require('pretty-ms');
const tmp = require('tmp');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const util = require('electron-util');
const PCancelable = require('p-cancelable');
const tempy = require('tempy');
const {track} = require('./common/analytics');
const {EditServiceContext} = require('./service-context');

const ffmpegPath = util.fixPathForAsarUnpack(ffmpeg.path);
const timeRegex = /time=\s*(\d\d:\d\d:\d\d.\d\d)/gm;
const speedRegex = /speed=\s*(-?\d+(,\d+)*(\.\d+(e\d+)?)?)/gm;

// https://trac.ffmpeg.org/ticket/309
const makeEven = n => 2 * Math.round(n / 2);

const getConvertFunction = shouldTrack => (outputPath, options, args) => {
  if (shouldTrack) {
    track(`file/export/fps/${options.fps}`);
  }

  return new PCancelable((resolve, reject, onCancel) => {
    const converter = execa(ffmpegPath, args);
    const durationMs = moment.duration(options.endTime - options.startTime, 'seconds').asMilliseconds();
    let speed;

    onCancel(() => {
      if (shouldTrack) {
        track('file/export/convert/canceled');
      }

      converter.kill();
    });

    let stderr = '';
    converter.stderr.setEncoding('utf8');
    converter.stderr.on('data', data => {
      stderr += data;

      data = data.trim();

      const processingSpeed = speedRegex.exec(data);

      if (processingSpeed) {
        speed = Number.parseFloat(processingSpeed[1]);
      }

      const timeProccessed = timeRegex.exec(data);

      if (timeProccessed) {
        const processedMs = moment.duration(timeProccessed[1]).asMilliseconds();
        const progress = processedMs / durationMs;

        // Wait 2 second in the conversion for the speed to be stable
        if (processedMs > 2 * 1000) {
          const msRemaining = (durationMs - processedMs) / speed;
          options.onProgress(progress, prettyMs(Math.max(msRemaining, 1000), {compact: true}).slice(1));
        } else {
          options.onProgress(progress);
        }
      }
    });

    converter.on('error', reject);

    converter.on('exit', code => {
      if (code === 0) {
        if (shouldTrack) {
          track('file/export/convert/completed');
        }

        resolve(outputPath);
      } else {
        if (shouldTrack) {
          track('file/export/convert/failed');
        }

        reject(new Error(`ffmpeg exited with code: ${code}\n\n${stderr}`));
      }
    });

    converter.catch(reject);
  });
};

const mute = PCancelable.fn(async (inputPath, onCancel) => {
  const mutedPath = tmp.tmpNameSync({postfix: path.extname(inputPath)});
  const converter = execa(ffmpegPath, [
    '-i', inputPath,
    '-an',
    '-vcodec', 'copy',
    mutedPath
  ]);

  onCancel(() => {
    converter.kill();
  });

  await converter;

  return mutedPath;
});

const convert = getConvertFunction(true);

const convertToMp4 = PCancelable.fn(async (options, onCancel) => {
  if (options.isMuted) {
    const muteProcess = mute(options.inputPath);

    onCancel(() => {
      muteProcess.cancel();
    });

    options.inputPath = await muteProcess;
  }

  return convert(options.outputPath, options, [
    '-i', options.inputPath,
    '-r', options.fps,
    ...(
      options.shouldCrop ? [
        '-s', `${makeEven(options.width)}x${makeEven(options.height)}`,
        '-ss', options.startTime,
        '-to', options.endTime
      ] : []
    ),
    options.outputPath
  ]);
});

const convertToWebm = PCancelable.fn(async (options, onCancel) => {
  if (options.isMuted) {
    const muteProcess = mute(options.inputPath);

    onCancel(() => {
      muteProcess.cancel();
    });

    options.inputPath = await muteProcess;
  }

  return convert(options.outputPath, options, [
    '-i', options.inputPath,
    // http://wiki.webmproject.org/ffmpeg
    // https://trac.ffmpeg.org/wiki/Encode/VP9
    '-threads', Math.max(os.cpus().length - 1, 1),
    '-deadline', 'good', // `best` is twice as slow and only slighty better
    '-b:v', '1M', // Bitrate (same as the MP4)
    '-codec:v', 'vp9',
    '-codec:a', 'vorbis',
    '-strict', '-2', // Needed because `vorbis` is experimental
    '-r', options.fps,
    ...(
      options.shouldCrop ? [
        '-s', `${options.width}x${options.height}`,
        '-ss', options.startTime,
        '-to', options.endTime
      ] : []
    ),
    options.outputPath
  ]);
});

// Should be similiar to the Gif generation
const convertToApng = options => {
  return convert(options.outputPath, options, [
    '-i', options.inputPath,
    '-vf', `fps=${options.fps}${options.shouldCrop ? `,scale=${options.width}:${options.height}:flags=lanczos` : ''}`,
    // Strange for APNG instead of -loop it uses -plays see: https://stackoverflow.com/questions/43795518/using-ffmpeg-to-create-looping-apng
    '-plays', options.loop === true ? '0' : '1', // 0 == forever; 1 == no loop
    ...(
      options.shouldCrop ? [
        '-ss', options.startTime,
        '-to', options.endTime
      ] : []
    ),
    options.outputPath
  ]);
};

// `time ffmpeg -i original.mp4 -vf fps=30,scale=480:-1::flags=lanczos,palettegen palette.png`
// `time ffmpeg -i original.mp4 -i palette.png -filter_complex 'fps=30,scale=-1:-1:flags=lanczos[x]; [x][1:v]paletteuse' palette.gif`
const convertToGif = PCancelable.fn(async (options, onCancel) => {
  const palettePath = tmp.tmpNameSync({postfix: '.png'});
  const paletteProcessor = execa(ffmpegPath, [
    ...(
      options.shouldCrop ? [
        '-ss', options.startTime,
        '-to', options.endTime
      ] : []
    ),
    '-i', options.inputPath,
    '-vf', `fps=${options.fps}${options.shouldCrop ? `,scale=${options.width}:${options.height}:flags=lanczos` : ''},palettegen`,
    palettePath
  ]);

  onCancel(() => {
    paletteProcessor.kill();
  });

  await paletteProcessor;

  return convert(options.outputPath, options, [
    '-i', options.inputPath,
    '-i', palettePath,
    '-filter_complex', `fps=${options.fps}${options.shouldCrop ? `,scale=${options.width}:${options.height}:flags=lanczos` : ''}[x]; [x][1:v]paletteuse`,
    '-loop', options.loop === true ? '0' : '-1', // 0 == forever; -1 == no loop
    ...(
      options.shouldCrop ? [
        '-ss', options.startTime,
        '-to', options.endTime
      ] : []
    ),
    options.outputPath
  ]);
});

const converters = new Map([
  ['gif', convertToGif],
  ['mp4', convertToMp4],
  ['webm', convertToWebm],
  ['apng', convertToApng]
]);

const convertTo = (options, format) => {
  const outputPath = path.join(tempy.directory(), options.defaultFileName);
  const converter = converters.get(format);

  if (!converter) {
    throw new Error(`Unsupported file format: ${format}`);
  }

  options.onProgress(0);
  track(`file/export/format/${format}`);

  if (options.editService) {
    return convertUsingPlugin({outputPath, format, converter, ...options});
  }

  return converter({outputPath, ...options});
};

const convertUsingPlugin = PCancelable.fn(async ({editService, converter, ...options}, onCancel) => {
  let croppedPath;

  if (options.shouldCrop) {
    croppedPath = tmp.tmpNameSync({postfix: path.extname(options.inputPath)});

    editService.setProgress('Cropping…');

    const cropProcess = execa(ffmpegPath, [
      '-i', options.inputPath,
      '-s', `${makeEven(options.width)}x${makeEven(options.height)}`,
      '-ss', options.startTime,
      '-to', options.endTime,
      croppedPath
    ]);

    onCancel(() => {
      cropProcess.kill();
    });

    await cropProcess;
  } else {
    croppedPath = options.inputPath;
  }

  let canceled = false;
  const convertFunction = getConvertFunction(false);

  const editPath = tmp.tmpNameSync({postfix: path.extname(croppedPath)});

  console.log('Export options', {
    ...options,
    inputPath: croppedPath,
    outputPath: editPath
  });

  const editProcess = editService.service.action(
    new EditServiceContext({
      onCancel: editService.cancel,
      config: editService.config,
      setProgress: editService.setProgress,
      convert: (args, progressText = 'Converting') => convertFunction(undefined, {
        endTime: options.endTime,
        startTime: options.startTime,
        onProgress: (percentage, estimate) => editService.setProgress(estimate ? `${progressText} — ${estimate} remaining` : `${progressText}…`, percentage)
      }, args),
      exportOptions: {
        ...options,
        inputPath: croppedPath,
        outputPath: editPath
      }
    })
  );

  if (editProcess.cancel && typeof editProcess.cancel === 'function') {
    onCancel(() => {
      canceled = true;
      editProcess.cancel();
    });
  }

  await editProcess;

  if (canceled) {
    return;
  }

  track(`plugins/used/edit/${editService.pluginName}`);

  return converter({
    ...options,
    shouldCrop: false,
    inputPath: editPath
  });
});

module.exports = {
  convertTo,
  converters
};
