const path = require("path");
const moduleAlias = require("module-alias");
const { getDevBundleDir } = require("./cli/dev-bundle");

moduleAlias.addAlias("punycode", "punycode/");

/*
* A warning was introduced in Node 22:
*
* "The `punycode` module is deprecated. Please use a userland alternative instead."
*
* The problem is that punycode is deeply integrated in the Node system. It's not a
* simple direct dependency.
*
* Check these issues for more details:
* https://github.com/mathiasbynens/punycode.js/issues/137
* https://stackoverflow.com/questions/68774489/punycode-is-deprecated-in-npm-what-should-i-replace-it-with/78946745
*
* This warning was, besides being annoying, breaking our tests.
*
* The solution below uses module-alias to "change" the punycode's name.
*/
async function setupPunycodeAlias() {
  const devBundleDir = await getDevBundleDir();
  const nodeModulesPath = path.join(devBundleDir, "lib", "node_modules");
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} -r ${path.join(
    nodeModulesPath,
    "module-alias",
    "register"
  )}`;
}

async function setupAlias() {
  return setupPunycodeAlias();
}

module.exports = {
  setupAlias,
};
