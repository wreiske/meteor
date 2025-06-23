import buildmessage from "../utils/buildmessage.js";
import {
  pathJoin,
  statOrNull,
  writeFile,
  unlink,
} from "../fs/files";

// Check if pnpm is available in the system
function isPnpmAvailable() {
  try {
    const which = require("which");
    which.sync("pnpm");
    return true;
  } catch (e) {
    return false;
  }
}

const INSTALL_JOB_MESSAGE_NPM = "installing npm dependencies";
const INSTALL_JOB_MESSAGE_PNPM = "installing pnpm dependencies";

export async function install(appDir, options) {
  const packageJsonPath = pathJoin(appDir, "package.json");
  const needTempPackageJson = ! statOrNull(packageJsonPath);

  if (needTempPackageJson) {
    // NOTE we need skel-minimal to pull in jQuery which right now is required for Blaze
    const { dependencies } = require("../static-assets/skel-blaze/package.json");

    // Write a minimal package.json with the same dependencies as the
    // default new-app package.json file.
    writeFile(
      packageJsonPath,
      JSON.stringify({ dependencies }, null, 2) + "\n",
      "utf8",
    );
  }

  // Check if pnpm is available and prefer it over npm
  const usePnpm = isPnpmAvailable();
  const installMessage = usePnpm ? INSTALL_JOB_MESSAGE_PNPM : INSTALL_JOB_MESSAGE_NPM;

  const ok = await buildmessage.enterJob(installMessage, async function () {
    const installCommand = ["install"];
    if (options && options.includeDevDependencies) {
      installCommand.push("--production=false");
    }

    let installResult;
    if (usePnpm) {
      const { runPnpmCommand } = require("../isobuild/meteor-npm.js");
      installResult = await runPnpmCommand(installCommand, appDir);
    } else {
      const { runNpmCommand } = require("../isobuild/meteor-npm.js");
      installResult = await runNpmCommand(installCommand, appDir);
    }

    if (! installResult.success) {
      const packageManager = usePnpm ? "pnpm" : "npm";
      buildmessage.error(
        `Could not install ${packageManager} dependencies for test-packages: ` +
          installResult.error);

      return false;
    }

    return true;
  });

  if (needTempPackageJson) {
    // Clean up the temporary package.json file created above.
    unlink(packageJsonPath);
  }

  return ok;
}
