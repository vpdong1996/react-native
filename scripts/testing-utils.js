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

// Artifacts URL is in the shape of:
// https://app.circleci.com/pipelines/github/facebook/react-native/<pipelineNumber>/workflows/<workflowId>>/jobs/<jobNumber>/artifacts/<artifactName>
class CircleCIArtifacts {
  #circleCIHeaders;
  #jobs;
  #workflowId;
  #pipelineNumber;

  constructor(circleCIToken) {
    this.circleCIToken = {'Circle-Token': circleCIToken};
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
    const emulatorArch = exec('adb shell getprop ro.product.cpu.abi');
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
  maybeLaunchAndroidEmulator,
  isPackagerRunning,
  launchPackagerInSeparateWindow,
  CircleCIArtifacts,
};
