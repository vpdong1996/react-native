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
const path = require('path');

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
  }).argv;

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

// === RNTester === //

/**
 * Start the test for RNTester on iOS.
 *
 * Parameters:
 * - @circleCIArtifacts manager object to manage all the download of CircleCIArtifacts. If null, it will fallback not to use them.
 */
async function testRNTesterIOS(circleCIArtifacts) {
  console.info(
    `We're going to test the ${
      argv.hermes ? 'Hermes' : 'JSC'
    } version of RNTester iOS with the new Architecture enabled`,
  );

  // remember that for this to be successful
  // you should have run bundle install once
  // in your local setup
  if (argv.hermes && circleCIArtifacts != null) {
    const hermesURL = await circleCIArtifacts.artifactURLHermesDebug();
    const hermesPath = path.join(circleCIArtifacts.baseTmpPath(), 'hermes-ios-debug.tar.gz');
    // download hermes source code from manifold
    circleCIArtifacts.downloadArtifact(hermesURL, hermesPath);
    console.info(`Downloaded Hermes in ${hermesPath}`);
    exec(
      `HERMES_ENGINE_TARBALL_PATH=${hermesPath} RCT_NEW_ARCH_ENABLED=1 bundle exec pod install --ansi`,
    );
  } else {
    exec(
      `USE_HERMES=${
        argv.hermes ? 1 : 0
      } CI=${onReleaseBranch} RCT_NEW_ARCH_ENABLED=1 bundle exec pod install --ansi`,
    );
  }

  // if everything succeeded so far, we can launch Metro and the app
  // start the Metro server in a separate window
  launchPackagerInSeparateWindow(pwd());

  // launch the app on iOS simulator
  exec(
    'npx react-native run-ios --scheme RNTester --simulator "iPhone 14"',
  );
}

/**
 * Start the test for RNTester on Android.
 *
 * Parameters:
 * - @circleCIArtifacts manager object to manage all the download of CircleCIArtifacts. If null, it will fallback not to use them.
 */
async function testRNTesterAndroid(circleCIArtifacts) {
  maybeLaunchAndroidEmulator();

  console.info(
    `We're going to test the ${
      argv.hermes ? 'Hermes' : 'JSC'
    } version of RNTester Android with the new Architecture enabled`,
  );

  // Start the Metro server so it will be ready if the app can be built and installed successfully.
  launchPackagerInSeparateWindow(pwd());

  if (circleCIArtifacts != null) {
    const downloadPath = path.join(circleCIArtifacts.baseTmpPath(), 'rntester.apk');

    const rntesterAPKURL = argv.hermes
      ? await circleCIArtifacts.artifactURLForHermesRNTesterAPK()
      : await circleCIArtifacts.artifactURLForJSCRNTesterAPK();

    console.info('Start Downloading APK');
    circleCIArtifacts.downloadArtifact(rntesterAPKURL, downloadPath);

    exec(`adb install ${downloadPath}`);
  } else {
    exec(
      `../../gradlew :packages:rn-tester:android:app:${
        argv.hermes ? 'installHermesDebug' : 'installJscDebug'
      } --quiet`,
    );
  }

  // launch the app
  // TODO: we should find a way to make it work like for iOS, via npx react-native run-android
  // currently, that fails with an error.
  exec(
    'adb shell am start -n com.facebook.react.uiapp/com.facebook.react.uiapp.RNTesterActivity',
  );

  // just to make sure that the Android up won't have troubles finding the Metro server
  exec('adb reverse tcp:8081 tcp:8081');
}

/**
 * Function that start testing on RNTester.
 *
 * Parameters:
 * - @circleCIArtifacts manager object to manage all the download of CircleCIArtifacts. If null, it will fallback not to use them.
 */
async function testRNTester(circleCIArtifacts) {
      // FIXME: make sure that the commands retains colors
    // (--ansi) doesn't always work
    // see also https://github.com/shelljs/shelljs/issues/86
    pushd('packages/rn-tester');

    if (argv.platform === 'iOS') {
      await testRNTesterIOS(circleCIArtifacts)
    } else {
      await testRNTesterAndroid(circleCIArtifacts)
    }
    popd();
}

// === RNTestProject === //

async function downloadArtifactsFromCircleCI(circleCIArtifacts, mavenLocalPath, localNodeTGZPath) {
  const mavenLocalURL = await circleCIArtifacts.artifactURLForMavenLocal();
  const packagedReactNativeURL =
    await circleCIArtifacts.artifactURLForPackagedReactNative();
  const hermesURL = await circleCIArtifacts.artifactURLHermesDebug();

  const packagedReactNativePath = '/tmp/packaged-react-native.tar.gz';
  const hermesPath = path.join(circleCIArtifacts.baseTmpPath(), 'hermes-ios-debug.tar.gz');

  console.info('[Download] Maven Local Artifacts');
  circleCIArtifacts.downloadArtifact(mavenLocalURL, mavenLocalPath);
  console.info('[Download] Packaged React Native');
  circleCIArtifacts.downloadArtifact(
    packagedReactNativeURL,
    packagedReactNativePath,
  );
  console.info('[Download] Hermes');
  circleCIArtifacts.downloadArtifact(hermesURL, hermesPath);

  exec(`cp ${packagedReactNativePath} ${localNodeTGZPath}`);
  return hermesPath;
}

function buildArtifactsLocally(releaseVersion, buildType, reactNativePackagePath) {
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
  hermesPath = generateiOSArtifacts(
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
async function prepareArtifacts(circleCIArtifacts, mavenLocalPath, localNodeTGZPath, releaseVersion, buildType, reactNativePackagePath) {
  return circleCIArtifacts != null
    ? await downloadArtifactsFromCircleCI(circleCIArtifacts, mavenLocalPath, localNodeTGZPath)
    : buildArtifactsLocally(releaseVersion, buildType, reactNativePackagePath);
}

async function testRNTestProject(circleCIArtifacts) {
  console.info("We're going to test a fresh new RN project");

  // create the local npm package to feed the CLI

  // base setup required (specular to publish-npm.js)
  const baseVersion =
    require('../packages/react-native/package.json').version;

  // in local testing, 1000.0.0 mean we are on main, every other case means we are
  // working on a release version
  const buildType = baseVersion !== '1000.0.0' ? 'release' : 'dry-run';

  // we need to add the unique timestamp to avoid npm/yarn to use some local caches
  const dateIdentifier = new Date()
    .toISOString()
    .slice(0, -8)
    .replace(/[-:]/g, '')
    .replace(/[T]/g, '-');

  const releaseVersion = `${baseVersion}-${dateIdentifier}`;

  // Prepare some variables for later use
  const repoRoot = pwd();
  const reactNativePackagePath = `${repoRoot}/packages/react-native`;
  const localNodeTGZPath = `${reactNativePackagePath}/react-native-${releaseVersion}.tgz`;
  const mavenLocalPath = circleCIArtifacts != null
    ? path.join(circleCIArtifacts.baseTmpPath(), 'maven-local.zip')
    : '/private/tmp/maven-local';
  const hermesPath = prepareArtifacts(circleCIArtifacts, mavenLocalPath, localNodeTGZPath, releaseVersion, buildType, reactNativePackagePath);

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

/**
 * Setups the CircleCIArtifacts if a token has been passed
 *
 * Parameters:
 * - @circleciToken a valid CircleCI Token.
 */
async function setupCircleCIArtifacts(circleciToken) {
  if (!circleciToken) {
    return null;
  }

  const baseTmpPath = '/tmp/react-native-tmp';
  const circleCIArtifacts = new CircleCIArtifacts(circleciToken, baseTmpPath);
  await circleCIArtifacts.initialize(branchName);
  return circleCIArtifacts;
}

async function main() {
  /*
   * see the test-local-e2e.js script for clean up process
   */

  // command order: we ask the user to select if they want to test RN tester
  // or RNTestProject

  // if they select RN tester, we ask if iOS or Android, and then we run the tests
  // if they select RNTestProject, we run the RNTestProject test

  checkPackagerRunning();

  const branchName = exec('git rev-parse --abbrev-ref HEAD', {
    silent: true,
  }).stdout.trim();
  const onReleaseBranch = branchName.endsWith('-stable');

  let circleCIArtifacts = await setupCircleCIArtifacts(argv.circleciToken);

  if (argv.target === 'RNTester') {
    await testRNTester(circleCIArtifacts);
  } else {
    await testRNTestProject(circleCIArtifacts);
  }
}

main();
