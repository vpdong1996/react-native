/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

'use strict';

const {exec} = require('shelljs');
const os = require('os');
const {spawn} = require('node:child_process');
const path = require('path');

const util = require('util');
const asyncRequest = require('request');
const request = util.promisify(asyncRequest);

/*
 * Android related utils - leverages android tooling
 */

// this code is taken from the CLI repo, slightly readapted to our needs
// here's the reference folder:
// https://github.com/react-native-community/cli/blob/main/packages/cli-platform-android/src/commands/runAndroid

const emulatorCommand = process.env.ANDROID_HOME
  ? `${process.env.ANDROID_HOME}/emulator/emulator`
  : 'emulator';

const getEmulators = () => {
  const emulatorsOutput = exec(`${emulatorCommand} -list-avds`).stdout;
  return emulatorsOutput.split(os.EOL).filter(name => name !== '');
};

const launchEmulator = emulatorName => {
  // we need both options 'cause reasons:
  // from docs: "When using the detached option to start a long-running process, the process will not stay running in the background after the parent exits unless it is provided with a stdio configuration that is not connected to the parent. If the parent's stdio is inherited, the child will remain attached to the controlling terminal."
  // here: https://nodejs.org/api/child_process.html#optionsdetached

  const cp = spawn(emulatorCommand, [`@${emulatorName}`], {
    detached: true,
    stdio: 'ignore',
  });

  cp.unref();
};

function tryLaunchEmulator() {
  const emulators = getEmulators();
  if (emulators.length > 0) {
    try {
      launchEmulator(emulators[0]);

      return {success: true};
    } catch (error) {
      return {success: false, error};
    }
  }
  return {
    success: false,
    error: 'No emulators found as an output of `emulator -list-avds`',
  };
}

function hasConnectedDevice() {
  const physicalDevices = exec('adb devices | grep -v emulator', {silent: true})
    .stdout.trim()
    .split('\n')
    .slice(1);
  return physicalDevices.length > 0;
}

function maybeLaunchAndroidEmulator() {
  if (hasConnectedDevice) {
    console.info('Already have a device connected. Skip launching emulator.');
    return;
  }

  const result = tryLaunchEmulator();
  if (result.success) {
    console.info('Successfully launched emulator.');
  } else {
    console.error(`Failed to launch emulator. Reason: ${result.error || ''}.`);
    console.warn(
      'Please launch an emulator manually or connect a device. Otherwise app may fail to launch.',
    );
  }
}

/*
 * iOS related utils - leverages xcodebuild
 */

/*
 * Metro related utils
 */

// inspired by CLI again https://github.com/react-native-community/cli/blob/main/packages/cli-tools/src/isPackagerRunning.ts

function isPackagerRunning(
  packagerPort = process.env.RCT_METRO_PORT || '8081',
) {
  try {
    const status = exec(`curl http://localhost:${packagerPort}/status`, {
      silent: true,
    }).stdout;

    return status === 'packager-status:running' ? 'running' : 'unrecognized';
  } catch (_error) {
    return 'not_running';
  }
}

// this is a very limited implementation of how this should work
function launchPackagerInSeparateWindow(folderPath) {
  const command = `tell application "Terminal" to do script "cd ${folderPath} && yarn start"`;
  exec(`osascript -e '${command}'`);
}

/**
 * Checks if Metro is running and it kills it if that's the case
 */
 function checkPackagerRunning() {
  if (isPackagerRunning() === 'running') {
    exec(
      "lsof -i :8081 | grep LISTEN | /usr/bin/awk '{print $2}' | xargs kill",
    );
  }
}

// === ARTIFACTS === //

/**
 * Setups the CircleCIArtifacts if a token has been passed
 *
 * Parameters:
 * - @circleciToken a valid CircleCI Token.
 * - @branchName the branch of the name we want to use to fetch the artifacts.
 */
 async function setupCircleCIArtifacts(circleciToken, branchName) {
  if (!circleciToken) {
    return null;
  }

  const baseTmpPath = '/tmp/react-native-tmp';
  const circleCIArtifacts = new CircleCIArtifacts(circleciToken, baseTmpPath);
  await circleCIArtifacts.initialize(branchName);
  return circleCIArtifacts;
}

async function downloadArtifactsFromCircleCI(
  circleCIArtifacts,
  mavenLocalPath,
  localNodeTGZPath,
) {
  const mavenLocalURL = await circleCIArtifacts.artifactURLForMavenLocal();
  const packagedReactNativeURL =
    await circleCIArtifacts.artifactURLForPackagedReactNative();
  const hermesURL = await circleCIArtifacts.artifactURLHermesDebug();

  const packagedReactNativePath = path.join(
    circleCIArtifacts.baseTmpPath,
    '/packaged-react-native.tar.gz',
  );
  const hermesPath = path.join(
    circleCIArtifacts.baseTmpPath,
    'hermes-ios-debug.tar.gz',
  );

  console.info('[Download] Maven Local Artifacts');
  circleCIArtifacts.downloadArtifact(mavenLocalURL, mavenLocalPath);
  console.info('[Download] Packaged React Native');
  circleCIArtifacts.downloadArtifact(
    packagedReactNativeURL,
    packagedReactNativePath,
  );
  console.info('[Download] Hermes');
  circleCIArtifacts.downloadArtifact(hermesURL, hermesPath);

  console.log(`>>> Copying the packaged version of react native\nfrom: '${packagedReactNativePath}\n  to: ${localNodeTGZPath}'`)
  exec(`cp ${packagedReactNativePath} ${localNodeTGZPath}`);
  return hermesPath;
}

function buildArtifactsLocally(
  releaseVersion,
  buildType,
  reactNativePackagePath,
) {
  // this is needed to generate the Android artifacts correctly
  const exitCode = exec(
    `node scripts/set-rn-version.js --to-version ${releaseVersion} --build-type ${buildType}`,
  ).code;

  if (exitCode !== 0) {
    console.error(
      `Failed to set the RN version. Version ${releaseVersion} is not valid for ${buildType}`,
    );
    process.exit(exitCode);
  }

  // Generate native files for Android
  generateAndroidArtifacts(releaseVersion);

  // Generate iOS Artifacts
  const jsiFolder = `${reactNativePackagePath}/ReactCommon/jsi`;
  const hermesCoreSourceFolder = `${reactNativePackagePath}/sdks/hermes`;

  if (!fs.existsSync(hermesCoreSourceFolder)) {
    console.info('The Hermes source folder is missing. Downloading...');
    downloadHermesSourceTarball();
    expandHermesSourceTarball();
  }

  // need to move the scripts inside the local hermes cloned folder
  // cp sdks/hermes-engine/utils/*.sh <your_hermes_checkout>/utils/.
  cp(
    `${reactNativePackagePath}/sdks/hermes-engine/utils/*.sh`,
    `${reactNativePackagePath}/sdks/hermes/utils/.`,
  );

  // for this scenario, we only need to create the debug build
  // (env variable PRODUCTION defines that podspec side)
  const buildTypeiOSArtifacts = 'Debug';

  // the android ones get set into /private/tmp/maven-local
  const localMavenPath = '/private/tmp/maven-local';

  // Generate native files for iOS
  const hermesPath = generateiOSArtifacts(
    jsiFolder,
    hermesCoreSourceFolder,
    buildTypeiOSArtifacts,
    localMavenPath,
  );

  return hermesPath;
}


/**
 * It prepares the artifacts required to run a new project created from the template
 *
 * Parameters:
 * - @circleCIArtifacts manager object to manage all the download of CircleCIArtifacts. If null, it will fallback not to use them.
 * - @mavenLocalPath path to the local maven repo that is needed by Android.
 * - @localNodeTGZPath path where we want to store the react-native tgz.
 * - @releaseVersion the version that is about to be released.
 * - @buildType the type of build we want to execute if we build locally.
 * - @reactNativePackagePath the path to the react native package within the repo.
 *
 * Returns:
 * - @hermesPath the path to hermes for iOS
 */
 async function prepareArtifacts(
  circleCIArtifacts,
  mavenLocalPath,
  localNodeTGZPath,
  releaseVersion,
  buildType,
  reactNativePackagePath,
) {
  return circleCIArtifacts != null
    ? await downloadArtifactsFromCircleCI(
        circleCIArtifacts,
        mavenLocalPath,
        localNodeTGZPath,
      )
    : buildArtifactsLocally(releaseVersion, buildType, reactNativePackagePath);
}

// Artifacts URL is in the shape of:
// https://app.circleci.com/pipelines/github/facebook/react-native/<pipelineNumber>/workflows/<workflowId>>/jobs/<jobNumber>/artifacts/<artifactName>
class CircleCIArtifacts {
  #circleCIHeaders;
  #jobs;
  #workflowId;
  #pipelineNumber;
  #baseTmpPath;

  constructor(circleCIToken, baseTmpPath) {
    this.circleCIToken = {'Circle-Token': circleCIToken};
    this.baseTmpPath = baseTmpPath;
    exec(`mkdir -p ${baseTmpPath}`);
  }

  async initialize(branchName) {
    console.info('Getting CircleCI infoes');
    const pipeline = await this.#getLastCircleCIPipelineID(branchName);
    const packageAndReleaseWorkflow = await this.#getPackageAndReleaseWorkflow(
      pipeline.id,
    );
    this.#throwIfPendingOrUnsuccessfulWorkflow(packageAndReleaseWorkflow);
    const testsWorkflow = await this.#getTestsWorkflow(pipeline.id);
    this.#throwIfPendingOrUnsuccessfulWorkflow(testsWorkflow);
    const jobsPromises = [
      this.#getCircleCIJobs(packageAndReleaseWorkflow.id),
      this.#getCircleCIJobs(testsWorkflow.id),
    ];

    const jobsResults = await Promise.all(jobsPromises);

    this.jobs = jobsResults.flatMap(jobs => jobs);
  }

  baseTmpPath() {
    return this.baseTmpPath;
  }

  async #throwIfPendingOrUnsuccessfulWorkflow(workflow) {
    if (workflow.status !== 'success') {
      throw new Error(
        `The ${workflow.name} workflow status is ${workflow.status}. Please, wait for it to be finished before start testing or fix it`,
      );
    }
  }

  async #getLastCircleCIPipelineID(branchName) {
    const options = {
      method: 'GET',
      url: 'https://circleci.com/api/v2/project/gh/facebook/react-native/pipeline',
      qs: {
        branch: branchName,
      },
      headers: this.circleCIHeaders,
    };

    const response = await request(options);
    if (response.error) {
      throw new Error(error);
    }

    const lastPipeline = JSON.parse(response.body).items[0];
    return {id: lastPipeline.id, number: lastPipeline.number};
  }

  async #getSpecificWorkflow(pipelineId, workflowName) {
    const options = {
      method: 'GET',
      url: `https://circleci.com/api/v2/pipeline/${pipelineId}/workflow`,
      headers: this.circleCIHeaders,
    };
    const response = await request(options);
    if (response.error) {
      throw new Error(error);
    }

    const body = JSON.parse(response.body);
    return body.items.find(workflow => workflow.name === workflowName);
  }

  async #getPackageAndReleaseWorkflow(pipelineId) {
    return this.#getSpecificWorkflow(
      pipelineId,
      'package_and_publish_release_dryrun',
    );
  }

  async #getTestsWorkflow(pipelineId) {
    return this.#getSpecificWorkflow(pipelineId, 'tests');
  }

  async #getCircleCIJobs(workflowId) {
    const options = {
      method: 'GET',
      url: `https://circleci.com/api/v2/workflow/${workflowId}/job`,
      headers: this.circleCIHeaders,
    };
    const response = await request(options);
    if (response.error) {
      throw new Error(error);
    }

    const body = JSON.parse(response.body);
    return body.items;
  }

  async #getJobsArtifacts(jobNumber) {
    const options = {
      method: 'GET',
      url: `https://circleci.com/api/v2/project/gh/facebook/react-native/${jobNumber}/artifacts`,
      headers: this.circleCIHeaders,
    };
    const response = await request(options);
    if (response.error) {
      throw new Error(error);
    }

    const body = JSON.parse(response.body);
    return body.items;
  }

  async #findUrlForJob(jobName, artifactPath) {
    const job = this.jobs.find(j => j.name === jobName);
    const artifacts = await this.#getJobsArtifacts(job.job_number);
    return artifacts.find(artifact => artifact.path.indexOf(artifactPath) > -1)
      .url;
  }

  async artifactURLHermesDebug() {
    return this.#findUrlForJob(
      'build_hermes_macos-Debug',
      'hermes-ios-debug.tar.gz',
    );
  }

  async artifactURLForMavenLocal() {
    return this.#findUrlForJob(
      'build_and_publish_npm_package-2',
      'maven-local.zip',
    );
  }

  async artifactURLForPackagedReactNative() {
    return this.#findUrlForJob(
      'build_and_publish_npm_package-2',
      'react-native-1000.0.0-',
    );
  }

  async artifactURLForHermesRNTesterAPK() {
    const emulatorArch = exec('adb shell getprop ro.product.cpu.abi').trim();
    return this.#findUrlForJob(
      'test_android',
      `rntester-apk/hermes/release/app-hermes-${emulatorArch}-release.apk`,
    );
  }

  async artifactURLForJSCRNTesterAPK() {
    return this.#findUrlForJob(
      'test_android',
      'rntester-apk/jsc/release/app-jsc-arm64-v8a-release.apk',
    );
  }

  downloadArtifact(artifactURL, destination) {
    exec(`rm -rf ${destination}`);
    exec(`curl ${artifactURL} -Lo ${destination}`);
  }
}

module.exports = {
  checkPackagerRunning,
  maybeLaunchAndroidEmulator,
  isPackagerRunning,
  launchPackagerInSeparateWindow,
  CircleCIArtifacts,
  setupCircleCIArtifacts,
  prepareArtifacts,
};
