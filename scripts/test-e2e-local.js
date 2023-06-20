/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

'use strict';

/*
 * This script is a re-interpretation of the old test-manual.e2e.sh script.
 * the idea is to provide a better DX for the manual testing.
 * It's using Javascript over Bash for consistency with the rest of the recent scripts
 * and to make it more accessible for other devs to play around with.
 */

const {exec, pushd, popd, pwd, cd} = require('shelljs');
const updateTemplatePackage = require('../scripts/update-template-package');
const yargs = require('yargs');

const {
  maybeLaunchAndroidEmulator,
  isPackagerRunning,
  launchPackagerInSeparateWindow,
  CircleCIArtifacts,
} = require('./testing-utils');


const argv = yargs
  .option('t', {
    alias: 'target',
    default: 'RNTester',
    choices: ['RNTester', 'RNTestProject'],
  })
  .option('p', {
    alias: 'platform',
    default: 'iOS',
    choices: ['iOS', 'Android'],
  })
  .option('h', {
    alias: 'hermes',
    type: 'boolean',
    default: true,
  })
  .option('c', {
    alias: 'circleciToken',
    type: 'string',
    required: true,
  }).argv;

async function main() {
  /*
   * see the test-local-e2e.js script for clean up process
   */

  // command order: we ask the user to select if they want to test RN tester
  // or RNTestProject

  // if they select RN tester, we ask if iOS or Android, and then we run the tests
  // if they select RNTestProject, we run the RNTestProject test

  // let's check if Metro is already running, if it is let's kill it and start fresh
  if (isPackagerRunning() === 'running') {
    exec(
      "lsof -i :8081 | grep LISTEN | /usr/bin/awk '{print $2}' | xargs kill",
    );
  }

  const branchName = exec('git rev-parse --abbrev-ref HEAD', {
    silent: true,
  }).stdout.trim();

  const onReleaseBranch = branchName.endsWith('-stable');

  const circleCIArtifacts = new CircleCIArtifacts(argv.circleciToken);
  await circleCIArtifacts.initialize(branchName);

  if (argv.target === 'RNTester') {
    // FIXME: make sure that the commands retains colors
    // (--ansi) doesn't always work
    // see also https://github.com/shelljs/shelljs/issues/86
    pushd('packages/rn-tester');

    if (argv.platform === 'iOS') {
      console.info(
        `We're going to test the ${
          argv.hermes ? 'Hermes' : 'JSC'
        } version of RNTester iOS with the new Architecture enabled`,
      );

      // remember that for this to be successful
      // you should have run bundle install once
      // in your local setup
      // NOTE: is this still relevant? 👇🏻
      // also: if I'm on release branch, I pick the
      // hermes ref from the hermes ref file (see hermes-engine.podspec)
      if (argv.hermes) {
        const hermesURL = await circleCIArtifacts.artifactURLHermesDebug();
        const hermesPath = '/tmp/hermes-ios-debug.tar.gz';
        // download hermes source code from manifold
        circleCIArtifacts.downloadArtifact(hermesURL, hermesPath);
        console.info(`Downloaded Hermes in ${hermesPath}`);
        exec(
          `HERMES_ENGINE_TARBALL_PATH=${hermesPath} RCT_NEW_ARCH_ENABLED=1 bundle exec pod install --ansi`,
        );
      } else {
        exec(
          `USE_HERMES=0 CI=${onReleaseBranch} RCT_NEW_ARCH_ENABLED=1 bundle exec pod install --ansi`,
        );
      }

      // if everything succeeded so far, we can launch Metro and the app
      // start the Metro server in a separate window
      launchPackagerInSeparateWindow(pwd());

      // launch the app on iOS simulator
      exec(
        'npx react-native run-ios --scheme RNTester --simulator "iPhone 14"',
      );
    } else {
      // we do the android path here

      maybeLaunchAndroidEmulator();

      console.info(
        `We're going to test the ${
          argv.hermes ? 'Hermes' : 'JSC'
        } version of RNTester Android with the new Architecture enabled`,
      );

      const downloadPath = '/tmp/rntester.apk';

      const rntesterAPKURL = argv.hermes
        ? await circleCIArtifacts.artifactURLForHermesRNTesterAPK()
        : await circleCIArtifacts.artifactURLForJSCRNTesterAPK();

      console.info('Start Downloading APK');
      circleCIArtifacts.downloadArtifact(rntesterAPKURL, downloadPath);

      exec(`adb install ${downloadPath}`);

      // launch the app on Android simulator
      // TODO: we should find a way to make it work like for iOS, via npx react-native run-android
      // currently, that fails with an error.

      // if everything succeeded so far, we can launch Metro and the app
      // start the Metro server in a separate window
      launchPackagerInSeparateWindow(pwd());

      // launch the app
      exec(
        'adb shell am start -n com.facebook.react.uiapp/com.facebook.react.uiapp.RNTesterActivity',
      );

      // just to make sure that the Android up won't have troubles finding the Metro server
      exec('adb reverse tcp:8081 tcp:8081');
    }
    popd();
  } else {
    console.info("We're going to test a fresh new RN project");

    // create the local npm package to feed the CLI

    // base setup required (specular to publish-npm.js)

    // we need to add the unique timestamp to avoid npm/yarn to use some local caches
    const baseVersion =
      require('../packages/react-native/package.json').version;

    // // in local testing, 1000.0.0 mean we are on main, every other case means we are
    // // working on a release version
    // const buildType = baseVersion !== '1000.0.0' ? 'release' : 'dry-run';

    const dateIdentifier = new Date()
      .toISOString()
      .slice(0, -8)
      .replace(/[-:]/g, '')
      .replace(/[T]/g, '-');

    const releaseVersion = `${baseVersion}-${dateIdentifier}`;

    // Generate native files for Android
    // generateAndroidArtifacts(releaseVersion);
    const mavenLocalURL = await circleCIArtifacts.artifactURLForMavenLocal();
    const packagedReactNativeURL =
      await circleCIArtifacts.artifactURLForPackagedReactNative();
    const hermesURL = await circleCIArtifacts.artifactURLHermesDebug();

    const mavenLocalPath = '/tmp/maven-local.zip';
    const packagedReactNativePath = '/tmp/packaged-react-native.tar.gz';
    const hermesPath = '/tmp/hermes-ios-debug.tar.gz';

    console.info('[Download] Maven Local Artifacts');
    circleCIArtifacts.downloadArtifact(mavenLocalURL, mavenLocalPath);
    console.info('[Download] Packaged React Native');
    circleCIArtifacts.downloadArtifact(
      packagedReactNativeURL,
      packagedReactNativePath,
    );
    console.info('[Download] Hermes');
    circleCIArtifacts.downloadArtifact(hermesURL, hermesPath);

    // Setting up generating native iOS (will be done later)
    const repoRoot = pwd();
    const reactNativePackagePath = `${repoRoot}/packages/react-native`;

    const localNodeTGZPath = `${reactNativePackagePath}/react-native-${releaseVersion}.tgz`;
    exec(`cp ${packagedReactNativePath} ${localNodeTGZPath}`);
    updateTemplatePackage({
      'react-native': `file:${localNodeTGZPath}`,
    });

    // create locally the node module
    exec('npm pack', {cwd: reactNativePackagePath});

    pushd('/tmp/');
    // need to avoid the pod install step - we'll do it later
    exec(
      `node ${reactNativePackagePath}/cli.js init RNTestProject --template ${localNodeTGZPath} --skip-install`,
    );

    cd('RNTestProject');

    // TODO: test whether that's works. On the local test it doesn't, but I'm forcing a version which is weird.
    exec('yarn install');

    // need to do this here so that Android will be properly setup either way
    exec(
      `echo "REACT_NATIVE_MAVEN_LOCAL_REPO=${mavenLocalPath}" >> android/gradle.properties`,
    );

    // doing the pod install here so that it's easier to play around RNTestProject
    cd('ios');
    exec('bundle install');
    exec(
      `HERMES_ENGINE_TARBALL_PATH=${hermesPath} USE_HERMES=${
        argv.hermes ? 1 : 0
      } bundle exec pod install --ansi`,
    );

    cd('..');

    if (argv.platform === 'iOS') {
      exec('yarn ios');
    } else {
      // android
      exec('yarn android');
    }
    popd();
  }
}

main();
