#!/usr/bin/env node
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

const util = require('util');
const asyncRequest = require('request');
const request = util.promisify(asyncRequest);

let circleCIHeaders;
let jobs;
let baseTemporaryPath;

async function initialize(circleCIToken, baseTempPath, branchName) {
    console.info('Getting CircleCI infoes');
    circleCIHeaders = {'Circle-Token': circleCIToken};
    baseTemporaryPath = baseTempPath;
    exec(`mkdir -p ${baseTemporaryPath}`);
    const pipeline = await _getLastCircleCIPipelineID(branchName);
    const packageAndReleaseWorkflow = await _getPackageAndReleaseWorkflow(
        pipeline.id,
    );
    _throwIfPendingOrUnsuccessfulWorkflow(packageAndReleaseWorkflow);
    const testsWorkflow = await _getTestsWorkflow(pipeline.id);
    _throwIfPendingOrUnsuccessfulWorkflow(testsWorkflow);
    const jobsPromises = [
        _getCircleCIJobs(packageAndReleaseWorkflow.id),
        _getCircleCIJobs(testsWorkflow.id),
    ];

    const jobsResults = await Promise.all(jobsPromises);

    jobs = jobsResults.flatMap(jobs => jobs);
}

function baseTmpPath() {
    return baseTemporaryPath;
}

async function _throwIfPendingOrUnsuccessfulWorkflow(workflow) {
    if (workflow.status !== 'success') {
    throw new Error(
        `The ${workflow.name} workflow status is ${workflow.status}. Please, wait for it to be finished before start testing or fix it`,
    );
    }
}

async function _getLastCircleCIPipelineID(branchName) {
    const options = {
    method: 'GET',
    url: 'https://circleci.com/api/v2/project/gh/facebook/react-native/pipeline',
    qs: {
        branch: branchName,
    },
    headers: circleCIHeaders,
    };

    const response = await request(options);
    if (response.error) {
    throw new Error(error);
    }

    const lastPipeline = JSON.parse(response.body).items[0];
    return {id: lastPipeline.id, number: lastPipeline.number};
}

async function _getSpecificWorkflow(pipelineId, workflowName) {
    const options = {
    method: 'GET',
    url: `https://circleci.com/api/v2/pipeline/${pipelineId}/workflow`,
    headers: circleCIHeaders,
    };
    const response = await request(options);
    if (response.error) {
    throw new Error(error);
    }

    const body = JSON.parse(response.body);
    return body.items.find(workflow => workflow.name === workflowName);
}

async function _getPackageAndReleaseWorkflow(pipelineId) {
    return _getSpecificWorkflow(
    pipelineId,
    'package_and_publish_release_dryrun',
    );
}

async function _getTestsWorkflow(pipelineId) {
    return _getSpecificWorkflow(pipelineId, 'tests');
}

async function _getCircleCIJobs(workflowId) {
    const options = {
        method: 'GET',
        url: `https://circleci.com/api/v2/workflow/${workflowId}/job`,
        headers: circleCIHeaders,
    };
    const response = await request(options);
    if (response.error) {
        throw new Error(error);
    }

    const body = JSON.parse(response.body);
    return body.items;
}

async function _getJobsArtifacts(jobNumber) {
    const options = {
    method: 'GET',
    url: `https://circleci.com/api/v2/project/gh/facebook/react-native/${jobNumber}/artifacts`,
    headers: circleCIHeaders,
    };
    const response = await request(options);
    if (response.error) {
    throw new Error(error);
    }

    const body = JSON.parse(response.body);
    return body.items;
}

async function _findUrlForJob(jobName, artifactPath) {
    const job = jobs.find(j => j.name === jobName);
    const artifacts = await _getJobsArtifacts(job.job_number);
    return artifacts.find(artifact => artifact.path.indexOf(artifactPath) > -1)
    .url;
}

async function artifactURLHermesDebug() {
    return _findUrlForJob(
        'build_hermes_macos-Debug',
        'hermes-ios-debug.tar.gz',
    );
}

async function artifactURLForMavenLocal() {
    return _findUrlForJob(
        'build_and_publish_npm_package-2',
        'maven-local.zip',
    );
}

async function artifactURLForHermesRNTesterAPK() {
    const emulatorArch = exec('adb shell getprop ro.product.cpu.abi').trim();
    return _findUrlForJob(
        'test_android',
        `rntester-apk/hermes/release/app-hermes-${emulatorArch}-release.apk`,
    );
}

async function artifactURLForJSCRNTesterAPK() {
    return _findUrlForJob(
        'test_android',
        'rntester-apk/jsc/release/app-jsc-arm64-v8a-release.apk',
    );
}

function downloadArtifact(artifactURL, destination) {
    exec(`rm -rf ${destination}`);
    exec(`curl ${artifactURL} -Lo ${destination}`);
}


module.exports = {
    initialize,
    downloadArtifact,
    artifactURLForJSCRNTesterAPK,
    artifactURLForHermesRNTesterAPK,
    artifactURLForMavenLocal,
    artifactURLHermesDebug,
    baseTmpPath,
};
